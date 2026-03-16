(function () {
  const apiBase = "/v0/management/token-usage";
  const managementApiBase = "/v0/management";
  const codexQuotaURL = "https://chatgpt.com/backend-api/wham/usage";
  const codexQuotaHeaders = {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal",
  };
  const secureStoragePrefix = "enc::v1::";
  const secureStorageNamespace = "cli-proxy-api-webui::secure-storage";
  const authStoreKey = "cli-proxy-auth";
  const themeStoreKey = "cli-proxy-theme";
  let currentRangeDays = 1;
  let managementKey = "";
  let trendChartInstance = null;
  let lastTrendPoints = [];
  let quotaLoading = false;

  const compactNumberFormatter = new Intl.NumberFormat("en-US", {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  });
  const fullNumberFormatter = new Intl.NumberFormat("en-US");

  const elements = {
    filterSummary: document.getElementById("filter-summary"),
    rangeTodayButton: document.getElementById("range-today-button"),
    range3dButton: document.getElementById("range-3d-button"),
    range7dButton: document.getElementById("range-7d-button"),
    range30dButton: document.getElementById("range-30d-button"),
    queryMessage: document.getElementById("query-message"),
    statusBadge: document.getElementById("status-badge"),
    totalTokens: document.getElementById("total-tokens"),
    totalRaw: document.getElementById("total-raw"),
    summaryCaption: document.getElementById("summary-caption"),
    activeFilters: document.getElementById("active-filters"),
    keyCountLabel: document.getElementById("key-count-label"),
    keySummaryBoard: document.getElementById("key-summary-board"),
    trendChart: document.getElementById("trend-chart"),
    trendTitle: document.getElementById("trend-title"),
    trendDescription: document.getElementById("trend-description"),
    quotaRefreshButton: document.getElementById("quota-refresh-button"),
    quotaCountLabel: document.getElementById("quota-count-label"),
    quotaMessage: document.getElementById("quota-message"),
    quotaList: document.getElementById("quota-list"),
  };

  function redirectToManagement() {
    window.location.replace("/management.html");
  }

  function todayString() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    const local = new Date(now.getTime() - offset * 60000);
    return local.toISOString().slice(0, 10);
  }

  function offsetDateString(daysFromToday) {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    const local = new Date(now.getTime() - offset * 60000);
    local.setUTCDate(local.getUTCDate() + daysFromToday);
    return local.toISOString().slice(0, 10);
  }

  function formatCompactNumber(value) {
    return compactNumberFormatter.format(Number(value || 0));
  }

  function formatFullNumber(value) {
    return fullNumberFormatter.format(Number(value || 0));
  }

  function disposeTrendChart() {
    if (trendChartInstance) {
      trendChartInstance.dispose();
      trendChartInstance = null;
    }
  }

  function rerenderTrendChart() {
    if (lastTrendPoints.length) {
      renderTrendChart(lastTrendPoints);
    }
  }

  function setQueryMessage(message, isError) {
    elements.queryMessage.textContent = message;
    elements.queryMessage.classList.toggle("error", Boolean(isError));
  }

  function setQuotaMessage(message, isError) {
    elements.quotaMessage.textContent = message;
    elements.quotaMessage.classList.toggle("error", Boolean(isError));
  }

  function setQuotaLoadingState(loading) {
    quotaLoading = Boolean(loading);
    if (elements.quotaRefreshButton) {
      elements.quotaRefreshButton.disabled = quotaLoading;
      elements.quotaRefreshButton.textContent = quotaLoading ? "正在加载..." : "刷新额度";
    }
  }

  function encodeText(value) {
    return new TextEncoder().encode(value);
  }

  function decodeText(value) {
    return new TextDecoder().decode(value);
  }

  function getEncryptionKey() {
    try {
      return encodeText(secureStorageNamespace + "|" + window.location.host + "|" + navigator.userAgent);
    } catch (error) {
      console.warn("token usage panel: fallback encryption key", error);
      return encodeText(secureStorageNamespace);
    }
  }

  function xorBytes(source, key) {
    const output = new Uint8Array(source.length);
    for (let index = 0; index < source.length; index += 1) {
      output[index] = source[index] ^ key[index % key.length];
    }
    return output;
  }

  function decodeBase64(value) {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      bytes[index] = raw.charCodeAt(index);
    }
    return bytes;
  }

  function decryptValue(value) {
    if (!value || !value.startsWith(secureStoragePrefix)) {
      return value;
    }
    try {
      const payload = value.slice(secureStoragePrefix.length);
      const encrypted = decodeBase64(payload);
      return decodeText(xorBytes(encrypted, getEncryptionKey()));
    } catch (error) {
      console.warn("token usage panel: decrypt failed", error);
      return value;
    }
  }

  function secureGetItem(key, options) {
    const settings = options || {};
    const encrypt = settings.encrypt !== false;
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return null;
    }

    try {
      const decoded = encrypt ? decryptValue(raw) : raw;
      return JSON.parse(decoded);
    } catch (error) {
      try {
        return encrypt && raw.startsWith(secureStoragePrefix) ? decryptValue(raw) : raw;
      } catch (_nestedError) {
        return null;
      }
    }
  }

  function readPersistedAuthState() {
    const persisted = secureGetItem(authStoreKey);
    if (!persisted || typeof persisted !== "object") {
      return {};
    }
    if (persisted.state && typeof persisted.state === "object") {
      return persisted.state;
    }
    return persisted;
  }

  function readThemeState() {
    try {
      const raw = localStorage.getItem(themeStoreKey);
      if (!raw) {
        return { theme: "auto", resolvedTheme: preferredTheme() };
      }
      const parsed = JSON.parse(raw);
      const state = parsed && typeof parsed === "object" && parsed.state ? parsed.state : parsed;
      return {
        theme: state && typeof state.theme === "string" ? state.theme : "auto",
        resolvedTheme: state && typeof state.resolvedTheme === "string" ? state.resolvedTheme : preferredTheme(),
      };
    } catch (_error) {
      return { theme: "auto", resolvedTheme: preferredTheme() };
    }
  }

  function preferredTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyThemeState() {
    const state = readThemeState();
    const theme = state.theme || "auto";
    const resolved = theme === "auto" ? preferredTheme() : theme;
    if (resolved === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
      return;
    }
    if (resolved === "white") {
      document.documentElement.setAttribute("data-theme", "white");
      return;
    }
    document.documentElement.removeAttribute("data-theme");
  }

  function resolveManagementKey() {
    const authState = readPersistedAuthState();
    const fromState = typeof authState.managementKey === "string" ? authState.managementKey.trim() : "";
    const directKey = secureGetItem("managementKey");
    const fromDirect = typeof directKey === "string" ? directKey.trim() : "";
    return fromState || fromDirect;
  }

  function requireManagementAuth() {
    const key = resolveManagementKey();
    if (!key) {
      redirectToManagement();
      return false;
    }
    managementKey = key;
    return true;
  }

  function authHeaders() {
    if (!managementKey) {
      redirectToManagement();
      throw new Error("缺少管理登录状态");
    }
    return {
      Authorization: managementKey.startsWith("Bearer ") ? managementKey : "Bearer " + managementKey,
    };
  }

  function buildURL(base, path, query) {
    const params = new URLSearchParams();
    Object.entries(query || {}).forEach(function ([key, value]) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        params.set(key, String(value).trim());
      }
    });

    return params.toString() ? base + path + "?" + params.toString() : base + path;
  }

  async function requestJSON(url, options) {
    const requestOptions = options || {};
    const response = await fetch(url, {
      method: requestOptions.method || "GET",
      headers: Object.assign({}, authHeaders(), requestOptions.headers || {}),
      body: requestOptions.body,
      cache: requestOptions.cache || "no-store",
    });

    if (response.status === 401 || response.status === 403) {
      redirectToManagement();
      throw new Error("管理登录已失效");
    }

    if (!response.ok) {
      const payload = await response.json().catch(function () {
        return {};
      });
      throw new Error(payload.message || payload.error || "请求失败");
    }

    return response.json();
  }

  async function apiGet(path, query) {
    const url = buildURL(apiBase, path, query);
    return requestJSON(url, { cache: "no-store" });
  }

  async function managementGet(path, query) {
    const url = buildURL(managementApiBase, path, query);
    return requestJSON(url, { cache: "no-store" });
  }

  async function managementPost(path, payload) {
    const url = managementApiBase + path;
    return requestJSON(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
      cache: "no-store",
    });
  }

  function readFilters() {
    return buildDateRangeQuery(currentRangeDays);
  }

  function buildDateRangeQuery(days) {
    const normalizedDays = normalizeRangeDays(days);
    return {
      date_from: normalizedDays === 1 ? todayString() : offsetDateString(-(normalizedDays - 1)),
      date_to: todayString(),
    };
  }

  function normalizeRangeDays(days) {
    return days === 3 || days === 7 || days === 30 ? days : 1;
  }

  function quickRangeLabel(days) {
    switch (normalizeRangeDays(days)) {
      case 3:
        return "近 3 天";
      case 7:
        return "近 7 天";
      case 30:
        return "近一个月";
      default:
        return "当天";
    }
  }

  function renderFilterSummary(filters) {
    elements.filterSummary.textContent = quickRangeLabel(rangeDaysFromQuery(filters));
  }

  function syncQuickRangeState() {
    const rangeMap = {
      today: currentRangeDays === 1,
      "3d": currentRangeDays === 3,
      "7d": currentRangeDays === 7,
      "30d": currentRangeDays === 30,
    };

    elements.rangeTodayButton.classList.toggle("active", rangeMap.today);
    elements.range3dButton.classList.toggle("active", rangeMap["3d"]);
    elements.range7dButton.classList.toggle("active", rangeMap["7d"]);
    elements.range30dButton.classList.toggle("active", rangeMap["30d"]);
  }

  function setDateRange(days) {
    currentRangeDays = normalizeRangeDays(days);
    syncQuickRangeState();
    renderFilterSummary(readFilters());
  }

  function renderSummary(summary) {
    const totals = summary.totals || {};
    const totalTokens = Number(totals.total_tokens || 0);
    elements.summaryCaption.textContent = buildCaption(summary.query || {});
    elements.totalTokens.textContent = formatCompactNumber(totalTokens);
    elements.totalRaw.textContent = formatFullNumber(totalTokens) + " tokens";
    renderFilterSummary(summary.query || {});
    renderActiveFilters(summary.query || {});
    renderKeyBoard(summary.by_api_key || [], totalTokens);
    updateTrendMeta(summary.query || {}, Number(summary.trend_range_days || 0));
    lastTrendPoints = Array.isArray(summary.trend_days) ? summary.trend_days : (Array.isArray(summary.last_7_days) ? summary.last_7_days : []);
    renderTrendChart(lastTrendPoints);
  }

  function buildCaption(query) {
    const label = quickRangeLabel(rangeDaysFromQuery(query));
    elements.statusBadge.textContent = label;
    return label + "的总 token 消耗";
  }

  function renderActiveFilters(query) {
    const chips = [buildFilterChip("范围", quickRangeLabel(rangeDaysFromQuery(query)))];
    elements.activeFilters.innerHTML = "";
    chips.forEach(function (chip) {
      elements.activeFilters.appendChild(chip);
    });
  }

  function buildFilterChip(label, value) {
    const chip = document.createElement("div");
    chip.className = "filter-chip";

    const labelNode = document.createElement("span");
    labelNode.className = "filter-chip-label";
    labelNode.textContent = label;

    const valueNode = document.createElement("span");
    valueNode.className = "filter-chip-value";
    valueNode.textContent = value;
    valueNode.title = value;

    chip.appendChild(labelNode);
    chip.appendChild(valueNode);
    return chip;
  }

  function formatDateRange(query) {
    const isSingleDay = query.date_from && query.date_to && query.date_from === query.date_to;
    if (isSingleDay) {
      return query.date_from === todayString() ? "今天" : query.date_from;
    }
    if (query.date_from || query.date_to) {
      return (query.date_from || "最早") + " 至 " + (query.date_to || "最新");
    }
    return "全部日期";
  }

  function rangeDaysFromQuery(query) {
    const dateFrom = query && query.date_from;
    const dateTo = query && query.date_to;
    if (!dateFrom || !dateTo) {
      return currentRangeDays;
    }
    const start = new Date(dateFrom + "T00:00:00");
    const end = new Date(dateTo + "T00:00:00");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return currentRangeDays;
    }
    const diffDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
    return normalizeRangeDays(diffDays);
  }

  function updateTrendMeta(query, trendRangeDays) {
    const normalizedTrendDays = trendRangeDays === 30 ? 30 : 7;
    if (normalizedTrendDays === 30) {
      elements.trendTitle.textContent = "近一个月总 Token";
      elements.trendDescription.textContent = "当前选择近一个月时，这里同步展示近一个月每天的 token 趋势。";
      return;
    }
    elements.trendTitle.textContent = "近 7 天总 Token";
    elements.trendDescription.textContent = "当前选择为当天、近 3 天或近 7 天时，这里固定展示近 7 天趋势。";
  }

  function renderKeyBoard(rows, totalTokens) {
    elements.keySummaryBoard.innerHTML = "";
    elements.keyCountLabel.textContent = rows.length + " 个 key";

    if (!rows.length) {
      const emptyState = document.createElement("div");
      emptyState.className = "empty-state";
      emptyState.textContent = "当前筛选条件下没有 key 消耗数据";
      elements.keySummaryBoard.appendChild(emptyState);
      return;
    }

    rows.forEach(function (row, index) {
      const tokenValue = Number(row.totals && row.totals.total_tokens ? row.totals.total_tokens : 0);
      const share = totalTokens > 0 ? (tokenValue / totalTokens) * 100 : 0;
      const rankingRow = document.createElement("article");
      rankingRow.className = "ranking-row";

      const rank = document.createElement("span");
      rank.className = "rank-badge";
      rank.textContent = "#" + (index + 1);

      const title = document.createElement("h3");
      title.className = "key-name";
      title.textContent = maskKey(row.value);
      title.title = maskKey(row.value);

      const compactValue = document.createElement("div");
      compactValue.className = "key-value";
      compactValue.textContent = formatCompactNumber(tokenValue);

      const fullValue = document.createElement("p");
      fullValue.className = "ranking-meta";
      fullValue.textContent = formatFullNumber(tokenValue) + " tokens";

      const valueGroup = document.createElement("div");
      valueGroup.className = "ranking-value-group";
      valueGroup.appendChild(compactValue);
      valueGroup.appendChild(fullValue);

      const mainGroup = document.createElement("div");
      mainGroup.className = "ranking-main";
      mainGroup.appendChild(rank);

      const textGroup = document.createElement("div");
      textGroup.className = "ranking-text";
      textGroup.appendChild(title);
      textGroup.appendChild(valueGroup);
      mainGroup.appendChild(textGroup);

      const meter = document.createElement("div");
      meter.className = "ranking-meter";
      const fill = document.createElement("div");
      fill.className = "ranking-meter-fill";
      fill.style.width = (share > 0 ? Math.max(share, 6) : 0).toFixed(1) + "%";
      meter.appendChild(fill);

      rankingRow.appendChild(mainGroup);
      rankingRow.appendChild(meter);
      elements.keySummaryBoard.appendChild(rankingRow);
    });
  }

  function maskSensitive(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "-";
    }
    if (text.length <= 1) {
      return text;
    }
    if (text.length <= 6) {
      return text.slice(0, 1) + "*".repeat(Math.max(text.length - 2, 0)) + text.slice(-1);
    }
    return text.slice(0, 3) + "*".repeat(text.length - 6) + text.slice(-3);
  }

  function maskKey(value) {
    return maskSensitive(value);
  }

  function normalizeString(value) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed || null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return null;
  }

  function toNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const numeric = Number(trimmed);
      return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
  }

  function toLowerValue(value) {
    const text = normalizeString(value);
    return text ? text.toLowerCase() : null;
  }

  function safeParseJSON(value) {
    if (value == null) {
      return null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      try {
        return JSON.parse(trimmed);
      } catch (_error) {
        return null;
      }
    }
    return typeof value === "object" ? value : null;
  }

  function decodeBase64Segment(value) {
    const text = normalizeString(value);
    if (!text) {
      return null;
    }
    try {
      const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      return atob(padded);
    } catch (_error) {
      return null;
    }
  }

  function parseTokenPayload(value) {
    if (!value) {
      return null;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const directObject = safeParseJSON(trimmed);
    if (directObject && typeof directObject === "object" && !Array.isArray(directObject)) {
      return directObject;
    }
    const segments = trimmed.split(".");
    if (segments.length < 2) {
      return null;
    }
    const decoded = decodeBase64Segment(segments[1]);
    if (!decoded) {
      return null;
    }
    const payload = safeParseJSON(decoded);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  }

  function extractCodexAccountId(entry) {
    const idToken = parseTokenPayload(entry && entry.id_token);
    return normalizeString(
      (idToken && (idToken.chatgpt_account_id ?? idToken.chatgptAccountId)) ??
      (entry && (entry.chatgpt_account_id ?? entry.chatgptAccountId))
    );
  }

  function resolveCodexPlanType(entry) {
    const idToken = parseTokenPayload(entry && entry.id_token);
    const candidates = [
      entry && (entry.plan_type ?? entry.planType),
      idToken && (idToken.plan_type ?? idToken.planType),
    ];
    for (let index = 0; index < candidates.length; index += 1) {
      const value = toLowerValue(candidates[index]);
      if (value) {
        return value;
      }
    }
    return null;
  }

  function resolveCodexPlanLabel(planType) {
    const normalized = toLowerValue(planType);
    if (normalized === "plus") {
      return "Plus";
    }
    if (normalized === "team") {
      return "Team";
    }
    if (normalized === "free") {
      return "Free";
    }
    return normalizeString(planType) || "-";
  }

  function resolveQuotaAccountLabel(entry) {
    return normalizeString(entry && entry.account) ||
      normalizeString(entry && entry.email) ||
      normalizeString(entry && entry.label) ||
      normalizeString(entry && entry.name) ||
      "-";
  }

  function formatQuotaUnixDate(seconds) {
    if (!seconds) {
      return "-";
    }
    const date = new Date(Number(seconds) * 1000);
    if (Number.isNaN(date.getTime())) {
      return "-";
    }
    return date.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function formatQuotaReset(windowData) {
    if (!windowData) {
      return "-";
    }
    const resetAt = toNumber(windowData.reset_at ?? windowData.resetAt);
    if (resetAt !== null && resetAt > 0) {
      return formatQuotaUnixDate(resetAt);
    }
    const resetAfterSeconds = toNumber(windowData.reset_after_seconds ?? windowData.resetAfterSeconds);
    if (resetAfterSeconds !== null && resetAfterSeconds > 0) {
      return formatQuotaUnixDate(Math.floor(Date.now() / 1000) + resetAfterSeconds);
    }
    return "-";
  }

  function extractResponseMessage(body) {
    const payload = safeParseJSON(body);
    if (payload && typeof payload === "object") {
      const direct = normalizeString(payload.message) ||
        normalizeString(payload.error) ||
        normalizeString(payload.detail);
      if (direct) {
        return direct;
      }
      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        const firstError = payload.errors[0];
        return normalizeString(firstError && (firstError.message || firstError.detail)) || "请求失败";
      }
    }
    return normalizeString(body) || "请求失败";
  }

  function resolveCodexWindowPair(rateLimit) {
    const pair = {
      primaryWindow: null,
      secondaryWindow: null,
    };
    const primaryCandidate = rateLimit && (rateLimit.primary_window ?? rateLimit.primaryWindow);
    const secondaryCandidate = rateLimit && (rateLimit.secondary_window ?? rateLimit.secondaryWindow);
    [primaryCandidate, secondaryCandidate].forEach(function (windowData) {
      if (!windowData) {
        return;
      }
      const duration = toNumber(windowData.limit_window_seconds || windowData.limitWindowSeconds);
      if (duration === 18000 && !pair.primaryWindow) {
        pair.primaryWindow = windowData;
        return;
      }
      if (duration === 604800 && !pair.secondaryWindow) {
        pair.secondaryWindow = windowData;
      }
    });
    if (!pair.primaryWindow) {
      pair.primaryWindow = primaryCandidate && primaryCandidate !== pair.secondaryWindow ? primaryCandidate : null;
    }
    if (!pair.secondaryWindow) {
      pair.secondaryWindow = secondaryCandidate && secondaryCandidate !== pair.primaryWindow ? secondaryCandidate : null;
    }
    return pair;
  }

  function buildCodexQuotaWindows(payload) {
    const windows = [];
    const standardRateLimit = payload.rate_limit ?? payload.rateLimit ?? null;
    const codeReviewRateLimit = payload.code_review_rate_limit ?? payload.codeReviewRateLimit ?? null;

    function pushWindow(id, label, windowData, limitReached, allowed) {
      if (!windowData) {
        return;
      }
      const resetLabel = formatQuotaReset(windowData);
      const rawUsedPercent = toNumber(windowData.used_percent ?? windowData.usedPercent);
      const usedPercent = rawUsedPercent !== null ? rawUsedPercent : (((Boolean(limitReached) || allowed === false) && resetLabel !== "-") ? 100 : null);
      const remainingPercent = usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent));
      windows.push({
        id: id,
        label: label,
        remainingPercent: remainingPercent,
        resetLabel: resetLabel,
      });
    }

    const standardPair = resolveCodexWindowPair(standardRateLimit);
    pushWindow(
      "primary-window",
      "5 小时限额",
      standardPair.primaryWindow,
      standardRateLimit && (standardRateLimit.limit_reached ?? standardRateLimit.limitReached),
      standardRateLimit && standardRateLimit.allowed
    );
    pushWindow(
      "secondary-window",
      "周限额",
      standardPair.secondaryWindow,
      standardRateLimit && (standardRateLimit.limit_reached ?? standardRateLimit.limitReached),
      standardRateLimit && standardRateLimit.allowed
    );

    const codeReviewPair = resolveCodexWindowPair(codeReviewRateLimit);
    pushWindow(
      "code-review-primary-window",
      "代码审查 5 小时限额",
      codeReviewPair.primaryWindow,
      codeReviewRateLimit && (codeReviewRateLimit.limit_reached ?? codeReviewRateLimit.limitReached),
      codeReviewRateLimit && codeReviewRateLimit.allowed
    );
    pushWindow(
      "code-review-secondary-window",
      "代码审查周限额",
      codeReviewPair.secondaryWindow,
      codeReviewRateLimit && (codeReviewRateLimit.limit_reached ?? codeReviewRateLimit.limitReached),
      codeReviewRateLimit && codeReviewRateLimit.allowed
    );

    return windows;
  }

  function renderTrendChart(points) {
    disposeTrendChart();
    elements.trendChart.innerHTML = "";

    if (!points.length) {
      const emptyState = document.createElement("div");
      emptyState.className = "empty-state";
      emptyState.textContent = "最近 7 天暂无 token 消耗数据";
      elements.trendChart.appendChild(emptyState);
      return;
    }

    if (!window.echarts) {
      const emptyState = document.createElement("div");
      emptyState.className = "empty-state";
      emptyState.textContent = "图表库加载失败，请刷新后重试";
      elements.trendChart.appendChild(emptyState);
      return;
    }

    const chartCanvas = document.createElement("div");
    chartCanvas.className = "trend-echart";
    elements.trendChart.appendChild(chartCanvas);

    const rootStyles = getComputedStyle(document.documentElement);
    const theme = document.documentElement.getAttribute("data-theme");
    const primaryColor = rootStyles.getPropertyValue("--primary-color").trim() || "#8b8680";
    const primaryHover = rootStyles.getPropertyValue("--primary-hover").trim() || primaryColor;
    const borderColor = rootStyles.getPropertyValue("--border-color").trim() || "#e3e1db";
    const textSecondary = rootStyles.getPropertyValue("--text-secondary").trim() || "#6d6760";
    const textTertiary = rootStyles.getPropertyValue("--text-tertiary").trim() || "#a29c95";
    const tooltipBackground = theme === "dark" ? "rgba(12, 11, 10, 0.96)" : "rgba(31, 28, 25, 0.94)";
    const tooltipBorder = theme === "dark" ? "rgba(255, 255, 255, 0.12)" : "rgba(255, 255, 255, 0.08)";

    trendChartInstance = window.echarts.init(chartCanvas, null, { renderer: "canvas" });
    trendChartInstance.setOption({
      animationDuration: 420,
      animationDurationUpdate: 260,
      color: [primaryColor],
      legend: {
        top: 0,
        left: 0,
        itemWidth: 10,
        itemHeight: 10,
        icon: "circle",
        textStyle: {
          color: textSecondary,
          fontSize: 12,
          fontWeight: 600,
        },
        data: ["总 Token"],
      },
      grid: {
        top: 46,
        right: 20,
        bottom: 18,
        left: 16,
        containLabel: true,
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: tooltipBackground,
        borderColor: tooltipBorder,
        borderWidth: 1,
        padding: [10, 12],
        textStyle: {
          color: "#ffffff",
          fontSize: 12,
        },
        extraCssText: "border-radius: 12px; box-shadow: 0 18px 36px rgba(17, 15, 13, 0.28);",
        axisPointer: {
          type: "line",
          lineStyle: {
            color: primaryColor,
            width: 1.5,
            type: "dashed",
            opacity: 0.82,
          },
        },
        formatter: function (params) {
          const firstItem = Array.isArray(params) ? params[0] : params;
          const value = firstItem && typeof firstItem.value !== "undefined" ? Number(firstItem.value || 0) : 0;
          const label = firstItem && firstItem.axisValue ? firstItem.axisValue : "-";
          const compactValue = formatCompactNumber(value);
          return [
            '<div style="font-size:11px;font-weight:600;letter-spacing:0.02em;color:rgba(255,255,255,0.72);">' + label + "</div>",
            '<div style="margin-top:4px;font-size:15px;font-weight:700;color:#ffffff;">' + compactValue + " Tokens</div>",
            '<div style="margin-top:2px;font-size:11px;color:rgba(255,255,255,0.72);">' + formatFullNumber(value) + " tokens</div>",
          ].join("");
        },
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: points.map(function (point) {
          return point.usage_date || "";
        }),
        axisLine: {
          lineStyle: {
            color: borderColor,
          },
        },
        axisTick: {
          show: false,
        },
        axisLabel: {
          color: textSecondary,
          fontSize: 12,
          fontWeight: 700,
          margin: 14,
          interval: 0,
          showMinLabel: true,
          showMaxLabel: true,
          hideOverlap: false,
          formatter: function (value) {
            return formatChartDate(value);
          },
        },
      },
      yAxis: {
        type: "value",
        splitNumber: 4,
        axisLine: {
          show: false,
        },
        axisTick: {
          show: false,
        },
        axisLabel: {
          color: textTertiary,
          fontSize: 12,
          margin: 16,
          formatter: function (value) {
            return formatCompactNumber(value);
          },
        },
        splitLine: {
          lineStyle: {
            color: borderColor,
            opacity: 0.78,
          },
        },
      },
      series: [
        {
          name: "总 Token",
          type: "line",
          smooth: 0.42,
          symbol: "circle",
          showSymbol: true,
          symbolSize: 9,
          data: points.map(function (point) {
            return Number(point.total_tokens || 0);
          }),
          lineStyle: {
            width: 3,
            color: primaryColor,
            cap: "round",
            join: "round",
          },
          itemStyle: {
            color: primaryColor,
            borderWidth: 0,
            shadowBlur: 10,
            shadowColor: "rgba(139, 134, 128, 0.24)",
          },
          emphasis: {
            focus: "series",
            scale: 1.35,
            itemStyle: {
              color: primaryHover,
              borderWidth: 0,
              shadowBlur: 18,
              shadowColor: "rgba(139, 134, 128, 0.34)",
            },
          },
          areaStyle: {
            color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(139, 134, 128, 0.28)" },
              { offset: 1, color: "rgba(139, 134, 128, 0.03)" },
            ]),
          },
        },
      ],
    });
  }

  function renderQuotaList(items) {
    elements.quotaList.innerHTML = "";
    elements.quotaCountLabel.textContent = items.length + " 个账号";

    if (!items.length) {
      const emptyState = document.createElement("div");
      emptyState.className = "empty-state";
      emptyState.textContent = "暂无 Codex 认证文件";
      elements.quotaList.appendChild(emptyState);
      return;
    }

    elements.quotaList.appendChild(buildQuotaHeader());
    items.forEach(function (item) {
      elements.quotaList.appendChild(buildQuotaRow(item));
    });
  }

  function renderQuotaIdleState() {
    elements.quotaList.innerHTML = "";
    elements.quotaCountLabel.textContent = "0 个账号";
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "点击“刷新额度”后加载列表";
    elements.quotaList.appendChild(emptyState);
  }

  function buildQuotaHeader() {
    const header = document.createElement("div");
    header.className = "quota-table-head";
    ["账号", "套餐", "5 小时限额", "周限额", "代码审查周限额"].forEach(function (label) {
      const cell = document.createElement("div");
      cell.className = "quota-table-head-cell";
      cell.textContent = label;
      header.appendChild(cell);
    });
    return header;
  }

  function buildQuotaRow(item) {
    const entry = item.entry || {};
    const row = document.createElement("article");
    row.className = "quota-table-row";

    row.appendChild(buildQuotaAccountCell(entry));
    row.appendChild(buildQuotaPlanCell(item));

    const windowsById = indexQuotaWindows(item.windows || []);
    row.appendChild(buildQuotaMetricCell(resolveQuotaMetricState(item, windowsById["primary-window"])));
    row.appendChild(buildQuotaMetricCell(resolveQuotaMetricState(item, windowsById["secondary-window"])));
    row.appendChild(buildQuotaMetricCell(resolveQuotaMetricState(item, windowsById["code-review-secondary-window"])));

    return row;
  }

  function buildQuotaAccountCell(entry) {
    const cell = document.createElement("div");
    cell.className = "quota-table-cell quota-table-account-cell";

    const value = document.createElement("div");
    value.className = "quota-account-value";
    value.textContent = maskSensitive(resolveQuotaAccountLabel(entry));

    cell.appendChild(value);
    return cell;
  }

  function buildQuotaPlanCell(item) {
    const cell = document.createElement("div");
    cell.className = "quota-table-cell quota-table-plan-cell";

    const value = document.createElement("div");
    value.className = "quota-plan-value";
    value.textContent = resolveCodexPlanLabel(item.planType);

    cell.appendChild(value);
    return cell;
  }

  function buildQuotaMetricCell(metric) {
    const cell = document.createElement("div");
    cell.className = "quota-table-cell quota-table-metric-cell";
    if (metric.statusClass) {
      cell.classList.add(metric.statusClass);
    }

    const value = document.createElement("div");
    value.className = "quota-percent";
    value.textContent = metric.valueText;

    const reset = document.createElement("div");
    reset.className = "quota-reset";
    reset.textContent = metric.resetText;

    cell.appendChild(value);
    cell.appendChild(reset);
    return cell;
  }

  function indexQuotaWindows(windows) {
    const index = {};
    (Array.isArray(windows) ? windows : []).forEach(function (windowData) {
      if (windowData && windowData.id) {
        index[windowData.id] = windowData;
      }
    });
    return index;
  }

  function resolveQuotaMetricState(item, windowData) {
    if (item.error) {
      return {
        valueText: "--",
        resetText: item.error,
        statusClass: "is-error",
      };
    }
    if (item.noAccess) {
      return {
        valueText: "--",
        resetText: "无 Codex 权限",
        statusClass: "is-muted",
      };
    }
    if (!windowData) {
      return {
        valueText: "--",
        resetText: "暂无额度数据",
        statusClass: "is-muted",
      };
    }
    return {
      valueText: windowData.remainingPercent === null ? "--" : Math.round(windowData.remainingPercent) + "%",
      resetText: windowData.resetLabel || "-",
      statusClass: quotaMetricClass(windowData.remainingPercent),
    };
  }

  function quotaMetricClass(remainingPercent) {
    const percent = remainingPercent === null ? 0 : remainingPercent;
    if (percent >= 80) {
      return "is-high";
    }
    if (percent >= 50) {
      return "is-medium";
    }
    return "is-low";
  }

  async function fetchCodexQuotaItem(entry) {
    const authIndex = normalizeString(entry && (entry.auth_index || entry.authIndex));
    if (!authIndex) {
      return {
        entry: entry,
      error: "认证文件缺少 auth_index",
      };
    }

    const accountId = extractCodexAccountId(entry);
    if (!accountId) {
      return {
        entry: entry,
        error: "Codex 凭证缺少 ChatGPT 账号 ID",
      };
    }

    const response = await managementPost("/api-call", {
      auth_index: authIndex,
      method: "GET",
      url: codexQuotaURL,
      header: Object.assign({}, codexQuotaHeaders, {
        "Chatgpt-Account-Id": accountId,
      }),
    });

    const statusCode = Number(response.status_code ?? response.statusCode ?? 0);
    if (statusCode < 200 || statusCode >= 300) {
      const requestError = new Error(extractResponseMessage(response.body ?? response.bodyText));
      requestError.status = statusCode;
      throw requestError;
    }

    const payload = safeParseJSON(response.body ?? response.bodyText);
    if (!payload || typeof payload !== "object") {
      throw new Error("暂无额度数据");
    }

    const planType = toLowerValue(payload.plan_type ?? payload.planType) || resolveCodexPlanType(entry);
    const windows = buildCodexQuotaWindows(payload);
    return {
      entry: entry,
      planType: planType,
      windows: windows,
      noAccess: planType === "free" && windows.length === 0,
    };
  }

  async function loadCodexQuota() {
    const response = await managementGet("/auth-files");
    const files = Array.isArray(response.files) ? response.files : [];
    const codexEntries = files.filter(function (entry) {
      return String(entry && (entry.provider || entry.type) || "").trim().toLowerCase() === "codex";
    });

    if (!codexEntries.length) {
      renderQuotaList([]);
      setQuotaMessage("当前没有可展示的 Codex 认证文件。", false);
      return;
    }

    const items = await Promise.all(codexEntries.map(async function (entry) {
      try {
        return await fetchCodexQuotaItem(entry);
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error("额度获取失败");
        const planType = resolveCodexPlanType(entry);
        if (normalizedError.status === 403 && planType === "free") {
          return {
            entry: entry,
            planType: planType,
            windows: [],
            noAccess: true,
          };
        }
        return {
          entry: entry,
          error: normalizedError.message || "额度获取失败",
        };
      }
    }));

    renderQuotaList(items);
    setQuotaMessage("Codex 额度已更新。", false);
  }

  async function refreshCodexQuota() {
    if (quotaLoading) {
      return;
    }
    try {
      setQuotaLoadingState(true);
      setQuotaMessage("正在加载额度...", false);
      await loadCodexQuota();
    } catch (error) {
      setQuotaMessage(error.message || "额度获取失败", true);
      elements.quotaList.innerHTML = "";
      elements.quotaCountLabel.textContent = "0 个账号";
      const errorState = document.createElement("div");
      errorState.className = "empty-state";
      errorState.textContent = "额度获取失败，请稍后重试";
      elements.quotaList.appendChild(errorState);
    } finally {
      setQuotaLoadingState(false);
    }
  }

  function buildTrendLinePath(coordinates) {
    if (!coordinates.length) {
      return "";
    }
    if (coordinates.length === 1) {
      return "M" + coordinates[0].x.toFixed(1) + " " + coordinates[0].y.toFixed(1);
    }
    const start = coordinates[0];
    return "M" + start.x.toFixed(1) + " " + start.y.toFixed(1) + buildTrendSegments(coordinates);
  }

  function buildTrendAreaPath(coordinates, baseline) {
    if (!coordinates.length) {
      return "";
    }
    const start = coordinates[0];
    const end = coordinates[coordinates.length - 1];
    if (coordinates.length === 1) {
      return [
        "M" + start.x.toFixed(1) + " " + baseline.toFixed(1),
        "L" + start.x.toFixed(1) + " " + start.y.toFixed(1),
        "L" + end.x.toFixed(1) + " " + baseline.toFixed(1),
        "Z",
      ].join(" ");
    }
    return [
      "M" + start.x.toFixed(1) + " " + baseline.toFixed(1),
      "L" + start.x.toFixed(1) + " " + start.y.toFixed(1),
      buildTrendSegments(coordinates),
      "L" + end.x.toFixed(1) + " " + baseline.toFixed(1),
      "Z",
    ].join(" ");
  }

  function buildTrendSegments(coordinates) {
    let segments = "";
    for (let index = 0; index < coordinates.length - 1; index += 1) {
      const p0 = coordinates[index - 1] || coordinates[index];
      const p1 = coordinates[index];
      const p2 = coordinates[index + 1];
      const p3 = coordinates[index + 2] || p2;
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      segments += " C" + cp1x.toFixed(1) + " " + cp1y.toFixed(1) + " " + cp2x.toFixed(1) + " " + cp2y.toFixed(1) + " " + p2.x.toFixed(1) + " " + p2.y.toFixed(1);
    }
    return segments;
  }

  function computeNiceStep(maxValue, segments) {
    const targetSegments = segments > 0 ? segments : 4;
    if (maxValue <= 0) {
      return 1;
    }
    const rawStep = maxValue / targetSegments;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const normalized = rawStep / magnitude;
    let step = 10;
    if (normalized <= 1) {
      step = 1;
    } else if (normalized <= 2) {
      step = 2;
    } else if (normalized <= 5) {
      step = 5;
    }
    return step * magnitude;
  }

  function formatChartDate(value) {
    if (!value) {
      return "-";
    }
    const parts = value.split("-");
    if (parts.length !== 3) {
      return value;
    }
    return String(Number(parts[1])) + "/" + String(Number(parts[2]));
  }

  async function loadSummary() {
    const filters = readFilters();
    renderFilterSummary(filters);
    const summary = await apiGet("/summary", filters);
    renderSummary(summary);
    setQueryMessage("看板已更新。点击快捷范围会刷新数据。", false);
  }

  async function refreshBoard() {
    try {
      setQueryMessage("正在加载看板数据...", false);
      await loadSummary();
    } catch (error) {
      setQueryMessage(error.message || "加载失败", true);
    }
  }

  function bindEvents() {
    elements.quotaRefreshButton.addEventListener("click", function () {
      void refreshCodexQuota();
    });

    elements.rangeTodayButton.addEventListener("click", function () {
      setDateRange(1);
      void refreshBoard();
    });

    elements.range3dButton.addEventListener("click", function () {
      setDateRange(3);
      void refreshBoard();
    });

    elements.range7dButton.addEventListener("click", function () {
      setDateRange(7);
      void refreshBoard();
    });

    elements.range30dButton.addEventListener("click", function () {
      setDateRange(30);
      void refreshBoard();
    });

    window.addEventListener("storage", function (event) {
      if (event.key === themeStoreKey) {
        applyThemeState();
        rerenderTrendChart();
      }
    });

    if (window.matchMedia) {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", function () {
          applyThemeState();
          rerenderTrendChart();
        });
      } else if (typeof media.addListener === "function") {
        media.addListener(function () {
          applyThemeState();
          rerenderTrendChart();
        });
      }
    }

    window.addEventListener("resize", function () {
      if (trendChartInstance) {
        trendChartInstance.resize();
      }
    });
  }

  (function init() {
    applyThemeState();
    setDateRange(1);
    renderQuotaIdleState();
    setQuotaMessage("点击“刷新额度”后才会请求 Codex 额度。", false);
    bindEvents();
    if (!requireManagementAuth()) {
      return;
    }
    void refreshBoard();
  })();
})();
