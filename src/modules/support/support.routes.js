const express = require("express");
const router = express.Router();
const supportController = require("./support.controller");

// /api/admin/support
router.get("/tickets", supportController.getTickets);
router.get("/tickets/:id", supportController.getTicketDetails);
router.put("/tickets/:id/status", supportController.updateStatus);
router.post("/tickets/:id/reply", supportController.addReply);

module.exports = router;
