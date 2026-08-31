const PostgresStorageMonitor = require('../../jobs/PostgresStorageMonitor');

class PostgresStorageController {
    async status(req, res) {
        try { return res.json({ success: true, data: await PostgresStorageMonitor.getStatus({ includeAnalysis: true }) }); }
        catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    }
    async check(req, res) {
        try { return res.json({ success: true, data: await PostgresStorageMonitor.check() }); }
        catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    }
    async audit(req, res) {
        try { return res.json({ success: true, data: await PostgresStorageMonitor.getAudit(req.query.limit) }); }
        catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    }
}

module.exports = new PostgresStorageController();
