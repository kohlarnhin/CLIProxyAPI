(function () {
  const apiBase = "/v0/management/token-usage";
  const secureStoragePrefix = "enc::v1::";
  const secureStorageNamespace = "cli-proxy-api-webui::secure-storage";
  const authStoreKey = "cli-proxy-auth";
  const themeStoreKey = "cli-proxy-theme";
  let lastOptionsKey = "";
  let filterExpanded = false;
  let managementKey = "";
  let trendChartInstance = null;
  let lastTrendPoints = [];

  const compactNumberFormatter = new Intl.NumberFormat("en-US", {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  });
  const fullNumberFormatter = new Intl.NumberFormat("en-US");

  const elements = {
    filterPanel: document.getElementById("filter-panel"),
    filterPanelBody: document.getElementById("filter-panel-body"),
    filterToggleButton: document.getElementById("filter-toggle-button"),
    filterSummary: document.getElementById("filter-summary"),
    queryButton: document.getElementById("query-button"),
    resetButton: document.getElementById("reset-button"),
    rangeTodayButton: document.getElementById("range-today-button"),
    range7dButton: document.getElementById("range-7d-button"),
    range30dButton: document.getElementById("range-30d-button"),
    queryMessage: document.getElementById("query-message"),
    statusBadge: document.getElementById("status-badge"),
    dateFrom: document.getElementById("date-from"),
    dateTo: document.getElementById("date-to"),
    apiKeyFilter: document.getElementById("api-key-filter"),
    modelFilter: document.getElementById("model-filter"),
    totalTokens: document.getElementById("total-tokens"),
    totalRaw: document.getElementById("total-raw"),
    summaryCaption: document.getElementById("summary-caption"),
    activeFilters: document.getElementById("active-filters"),
    keyCountLabel: document.getElementById("key-count-label"),
    keySummaryBoard: document.getElementById("key-summary-board"),
    trendChart: document.getElementById("trend-chart"),
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

  function setDefaultDates() {
    const today = todayString();
    elements.dateFrom.value = today;
    elements.dateTo.value = today;
    elements.statusBadge.textContent = "今天";
    syncQuickRangeState();
    renderFilterSummary(readFilters());
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

  async function apiGet(path, query) {
    const params = new URLSearchParams();
    Object.entries(query || {}).forEach(function ([key, value]) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        params.set(key, String(value).trim());
      }
    });

    const url = params.toString() ? apiBase + path + "?" + params.toString() : apiBase + path;
    const response = await fetch(url, {
      headers: authHeaders(),
      cache: "no-store",
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

  function readFilters() {
    return {
      date_from: elements.dateFrom.value,
      date_to: elements.dateTo.value,
      api_key: elements.apiKeyFilter.value,
      model: elements.modelFilter.value,
    };
  }

  function readOptionFilters() {
    return {
      date_from: elements.dateFrom.value,
      date_to: elements.dateTo.value,
    };
  }

  function renderFilterSummary(filters) {
    const items = [
      formatDateRange(filters || {}),
      filters && filters.api_key ? "Key: " + filters.api_key : "全部 key",
      filters && filters.model ? "模型: " + filters.model : "全部模型",
    ];
    elements.filterSummary.textContent = items.join(" / ");
  }

  function setFilterExpanded(expanded) {
    filterExpanded = Boolean(expanded);
    elements.filterPanel.classList.toggle("filter-panel-collapsed", !filterExpanded);
    elements.filterToggleButton.setAttribute("aria-expanded", String(filterExpanded));
    elements.filterToggleButton.textContent = filterExpanded ? "收起筛选" : "展开筛选";
  }

  function syncQuickRangeState() {
    const today = todayString();
    const rangeMap = {
      today: elements.dateFrom.value === today && elements.dateTo.value === today,
      "7d": elements.dateFrom.value === offsetDateString(-6) && elements.dateTo.value === today,
      "30d": elements.dateFrom.value === offsetDateString(-29) && elements.dateTo.value === today,
    };

    elements.rangeTodayButton.classList.toggle("active", rangeMap.today);
    elements.range7dButton.classList.toggle("active", rangeMap["7d"]);
    elements.range30dButton.classList.toggle("active", rangeMap["30d"]);
  }

  function setDateRange(days) {
    elements.dateTo.value = todayString();
    elements.dateFrom.value = days === 1 ? todayString() : offsetDateString(-(days - 1));
    syncQuickRangeState();
    renderFilterSummary(readFilters());
    lastOptionsKey = "";
  }

  function optionKey(filters) {
    return JSON.stringify(filters || {});
  }

  function renderOptions(options) {
    renderSelectOptions(elements.apiKeyFilter, options.api_keys || [], "全部 key");
    renderSelectOptions(elements.modelFilter, options.models || [], "全部模型");
  }

  function renderSelectOptions(select, values, emptyLabel) {
    const previousValue = select.value;
    select.innerHTML = "";

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = emptyLabel;
    select.appendChild(emptyOption);

    values.forEach(function (value) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });

    if (previousValue && values.indexOf(previousValue) !== -1) {
      select.value = previousValue;
      return;
    }
    select.value = "";
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
    lastTrendPoints = Array.isArray(summary.last_7_days) ? summary.last_7_days : [];
    renderTrendChart(lastTrendPoints);
  }

  function buildCaption(query) {
    const isSingleDay = query.date_from && query.date_to && query.date_from === query.date_to;
    if (isSingleDay) {
      const singleDay = query.date_from;
      elements.statusBadge.textContent = singleDay === todayString() ? "今天" : singleDay;
      return (singleDay === todayString() ? "今天" : singleDay) + "的总 token 消耗";
    }
    if (query.date_from || query.date_to) {
      const start = query.date_from || "最早";
      const end = query.date_to || "最新";
      elements.statusBadge.textContent = "区间";
      return start + " 至 " + end + " 的总 token 消耗";
    }
    elements.statusBadge.textContent = "全部";
    return "全部日期的总 token 消耗";
  }

  function renderActiveFilters(query) {
    const chips = [
      buildFilterChip("日期", formatDateRange(query)),
      buildFilterChip("Key", query.api_key || "全部 key"),
      buildFilterChip("模型", query.model || "全部模型"),
    ];
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

  function maskKey(value) {
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
        right: 10,
        bottom: 12,
        left: 8,
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
          return [
            '<div style="font-size:11px;font-weight:600;letter-spacing:0.02em;color:rgba(255,255,255,0.72);">' + label + "</div>",
            '<div style="margin-top:4px;font-size:15px;font-weight:700;color:#ffffff;">' + formatFullNumber(value) + " Tokens</div>",
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
    return parts[1] + "/" + parts[2];
  }

  async function loadOptions() {
    const filters = readOptionFilters();
    const nextKey = optionKey(filters);
    if (nextKey === lastOptionsKey) {
      return;
    }

    const options = await apiGet("/options", filters);
    renderOptions(options);
    lastOptionsKey = nextKey;
  }

  async function refreshOptionsOnly() {
    try {
      await loadOptions();
      syncQuickRangeState();
      setQueryMessage("已根据当前日期更新 key 和模型下拉列表。", false);
    } catch (error) {
      setQueryMessage(error.message || "筛选项加载失败", true);
    }
  }

  async function loadSummary() {
    const filters = readFilters();
    renderFilterSummary(filters);
    await loadOptions();
    const summary = await apiGet("/summary", filters);
    renderSummary(summary);
    setQueryMessage("看板已更新。数据只会在刷新页面或手动查询时变化。", false);
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
    elements.filterToggleButton.addEventListener("click", function () {
      setFilterExpanded(!filterExpanded);
    });

    elements.queryButton.addEventListener("click", function () {
      void refreshBoard();
    });

    elements.resetButton.addEventListener("click", function () {
      setDefaultDates();
      elements.apiKeyFilter.value = "";
      elements.modelFilter.value = "";
      lastOptionsKey = "";
      void refreshBoard();
    });

    elements.rangeTodayButton.addEventListener("click", function () {
      setDateRange(1);
      elements.apiKeyFilter.value = "";
      elements.modelFilter.value = "";
      void refreshBoard();
    });

    elements.range7dButton.addEventListener("click", function () {
      setDateRange(7);
      elements.apiKeyFilter.value = "";
      elements.modelFilter.value = "";
      void refreshBoard();
    });

    elements.range30dButton.addEventListener("click", function () {
      setDateRange(30);
      elements.apiKeyFilter.value = "";
      elements.modelFilter.value = "";
      void refreshBoard();
    });

    elements.dateFrom.addEventListener("change", function () {
      lastOptionsKey = "";
      syncQuickRangeState();
      renderFilterSummary(readFilters());
      void refreshOptionsOnly();
    });

    elements.dateTo.addEventListener("change", function () {
      lastOptionsKey = "";
      syncQuickRangeState();
      renderFilterSummary(readFilters());
      void refreshOptionsOnly();
    });

    elements.apiKeyFilter.addEventListener("change", function () {
      renderFilterSummary(readFilters());
    });

    elements.modelFilter.addEventListener("change", function () {
      renderFilterSummary(readFilters());
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
    setFilterExpanded(false);
    setDefaultDates();
    bindEvents();
    if (!requireManagementAuth()) {
      return;
    }
    void refreshBoard();
  })();
})();
