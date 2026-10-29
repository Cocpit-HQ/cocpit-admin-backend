const { pool } = require("../../config/db");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

exports.getTickets = async (req, res) => {
    try {
        const db = req.db || pool;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const countRes = await db.query("SELECT COUNT(*) FROM support_tickets");
        const total = parseInt(countRes.rows[0].count);

        const result = await db.query(
            `SELECT ticket_id as id, email, description as issue, attachment_url as attachment, status, created_at as date
             FROM support_tickets
             ORDER BY created_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        return res.status(200).json({
            success: true,
            tickets: result.rows,
            pagination: {
                page,
                limit,
                total,
                hasMore: offset + result.rows.length < total,
            },
        });
    } catch (error) {
        console.error("Get tickets error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch tickets" });
    }
};

exports.getTicketDetails = async (req, res) => {
    try {
        const db = req.db || pool;
        const { id } = req.params;

        const ticketRes = await db.query(
            `SELECT ticket_id as id, email, description as issue, attachment_url as attachment, status, created_at as date
             FROM support_tickets
             WHERE ticket_id = $1`,
            [id]
        );

        if (ticketRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Ticket not found" });
        }

        // Query existing columns in ticket_replies and project is_internal_note based on sender_type
        const repliesRes = await db.query(
            `SELECT reply_id, 
                    sender_id AS admin_id, 
                    sender_type, 
                    message, 
                    (sender_type = 'NOTE' OR sender_type = 'INTERNAL_NOTE') AS is_internal_note, 
                    created_at
             FROM ticket_replies
             WHERE ticket_id = $1
             ORDER BY created_at ASC`,
            [id]
        );

        return res.status(200).json({
            success: true,
            ticket: ticketRes.rows[0],
            replies: repliesRes.rows,
        });
    } catch (error) {
        console.error("Get ticket details error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch ticket details" });
    }
};

exports.updateStatus = async (req, res) => {
    try {
        const db = req.db || pool;
        const { id } = req.params;
        const { status } = req.body;

        const validStatuses = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status" });
        }

        const result = await db.query(
            `UPDATE support_tickets
             SET status = $1, updated_at = NOW()
             WHERE ticket_id = $2
             RETURNING ticket_id as id, status`,
            [status, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Ticket not found" });
        }

        return res.status(200).json({
            success: true,
            message: "Status updated successfully",
            ticket: result.rows[0],
        });
    } catch (error) {
        console.error("Update ticket status error:", error);
        return res.status(500).json({ success: false, message: "Failed to update ticket status" });
    }
};

exports.addReply = async (req, res) => {
    try {
        const db = req.db || pool;
        const { id } = req.params;
        const { message, is_internal_note } = req.body;
        const adminId = req.user?.userId || req.user?.id || req.admin?.id || null;

        if (!message) {
            return res.status(400).json({ success: false, message: "Message is required" });
        }

        const ticketRes = await db.query("SELECT email FROM support_tickets WHERE ticket_id = $1", [id]);
        if (ticketRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Ticket not found" });
        }
        const userEmail = ticketRes.rows[0].email;

        // Ensure sender_id has a valid UUID
        let senderId = adminId;
        if (!senderId) {
            const adminLookup = await db.query("SELECT admin_id FROM admin_panel_users LIMIT 1");
            senderId = adminLookup.rows[0]?.admin_id || "00000000-0000-0000-0000-000000000000";
        }

        const senderType = is_internal_note ? "NOTE" : "ADMIN";

        const result = await db.query(
            `INSERT INTO ticket_replies (ticket_id, sender_type, sender_id, message)
             VALUES ($1, $2, $3, $4)
             RETURNING reply_id, sender_id AS admin_id, sender_type, message, 
                       (sender_type = 'NOTE' OR sender_type = 'INTERNAL_NOTE') AS is_internal_note, 
                       created_at`,
            [id, senderType, senderId, message]
        );

        if (!is_internal_note) {
            // Send email to the user
            try {
                await resend.emails.send({
                    from: "Cocpit Support <noreply@cocpit.in>", 
                    to: userEmail,
                    subject: "Re: Your Support Request",
                    text: message,
                });
            } catch (emailError) {
                console.error("Failed to send email via Resend:", emailError);
                // We do not fail the request, but log the error
            }
        }

        return res.status(201).json({
            success: true,
            message: is_internal_note ? "Note added" : "Reply sent to user",
            reply: result.rows[0],
        });
    } catch (error) {
        console.error("Add reply error:", error);
        return res.status(500).json({ success: false, message: "Failed to add reply/note" });
    }
};
