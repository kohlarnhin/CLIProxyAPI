package management

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v6/internal/usage"
)

// GetUsageLedgerSummary returns aggregated usage totals for the requested filters.
func (h *Handler) GetUsageLedgerSummary(c *gin.Context) {
	var query usage.UsageLedgerQuery
	if err := c.ShouldBindQuery(&query); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid query", "message": err.Error()})
		return
	}

	store := usage.DefaultSQLitePersistence()
	if store == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "usage sqlite unavailable"})
		return
	}

	summary, err := store.QuerySummary(c.Request.Context(), query)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to query usage summary", "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, summary)
}

// GetUsageLedgerRecords returns paginated usage detail rows for the requested filters.
func (h *Handler) GetUsageLedgerRecords(c *gin.Context) {
	var query usage.UsageLedgerQuery
	if err := c.ShouldBindQuery(&query); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid query", "message": err.Error()})
		return
	}

	store := usage.DefaultSQLitePersistence()
	if store == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "usage sqlite unavailable"})
		return
	}

	page, err := store.QueryRecords(c.Request.Context(), query)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to query usage records", "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, page)
}

// GetUsageLedgerOptions returns filter options for the usage dashboard.
func (h *Handler) GetUsageLedgerOptions(c *gin.Context) {
	var query usage.UsageLedgerQuery
	if err := c.ShouldBindQuery(&query); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid query", "message": err.Error()})
		return
	}

	store := usage.DefaultSQLitePersistence()
	if store == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "usage sqlite unavailable"})
		return
	}

	options, err := store.QueryOptions(c.Request.Context(), query)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query usage options", "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, options)
}
