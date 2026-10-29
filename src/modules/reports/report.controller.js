const { pool } = require('../../config/db');

exports.getReportReasons = async (req, res) => {
  try {
    const result = await req.db.query('SELECT DISTINCT code, label FROM report_reasons ORDER BY code');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching report reasons:', err);
    res.status(500).json({ error: 'Server error fetching reasons' });
  }
};

exports.getReports = async (req, res) => {
  try {
    const { status = 'active', page = 1, limit = 10, type, reason, severity, targetUserId, reporterId } = req.query;
    const offset = (page - 1) * limit;

    let whereConditions = [];
    let queryParams = [];

    if (status && status !== 'all') {
      if (status === 'active') {
        whereConditions.push("r.status IN ('active', 'pending')");
      } else if (status === 'escalated') {
        whereConditions.push("r.status = 'escalated'");
      } else if (status === 'resolved') {
        whereConditions.push("r.status IN ('resolved', 'action_taken')");
      } else if (status === 'dismissed') {
        whereConditions.push("r.status IN ('dismissed', 'no_action')");
      } else if (status === 'all_resolved' || status === 'resolved,dismissed') {
        whereConditions.push("r.status IN ('resolved', 'action_taken', 'dismissed', 'no_action')");
      } else {
        queryParams.push(status);
        whereConditions.push(`r.status = ${queryParams.length}`);
      }
    }

    if (type && type !== 'All') {
      queryParams.push(type);
      whereConditions.push(`r.target_type = ${queryParams.length}`);
    }
    if (reason && reason !== 'All') {
      queryParams.push(reason);
      whereConditions.push(`(r.reason = ${queryParams.length} OR rr.label = ${queryParams.length} OR r.custom_reason = ${queryParams.length})`);
    }
    if (severity && severity !== 'All') {
      queryParams.push(severity);
      whereConditions.push(`r.severity = ${queryParams.length}`);
    }
    if (targetUserId) {
      queryParams.push(targetUserId);
      whereConditions.push(`(
        (r.target_type = 'USER' AND r.target_id::text = ${queryParams.length}::text) OR
        (r.target_type IN ('Content', 'POST') AND p.author_id::text = ${queryParams.length}::text) OR
        (r.target_type IN ('COMMENT', 'THOUGHT') AND pc.author_id::text = ${queryParams.length}::text)
      )`);
    }
    if (reporterId) {
      queryParams.push(reporterId);
      whereConditions.push(`r.reporter_id::text = ${queryParams.length}::text`);
    }

    let whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    const baseJoin = `
      FROM reports r
      LEFT JOIN report_reasons rr ON r.reason_id = rr.id
      LEFT JOIN users u ON r.reporter_id = u.user_id
      LEFT JOIN users target_u ON (r.target_type = 'USER' AND r.target_id = target_u.user_id)
      LEFT JOIN posts p ON (r.target_type IN ('Content', 'POST') AND r.target_id = p.post_id)
      LEFT JOIN users pu ON p.author_id = pu.user_id
      LEFT JOIN organizations po ON p.author_org_id = po.org_id
      LEFT JOIN post_comments pc ON (r.target_type IN ('COMMENT', 'THOUGHT') AND r.target_id = pc.comment_id)
      LEFT JOIN users cu ON pc.author_id = cu.user_id
    `;

    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) ${baseJoin} ${whereClause}`;
    const countResult = await req.db.query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count, 10);

    const query = `
      SELECT 
        r.id,
        r.target_type as type,
        r.target_type as "rawType",
        COALESCE(r.severity, 'Tier 1 (Minor)') as severity,
        COALESCE(r.offenses, 1) as offenses,
        COALESCE(r.content_preview, p.content, pc.content, 'Content reported') as "contentPreview",
        (SELECT url FROM post_media pm WHERE pm.post_id::text = r.target_id::text LIMIT 1) as "image",
        r.created_at as "postTime",
        r.resolved_at as "resolvedAt",
        r.target_id as "postId",
        COALESCE(rr.label, r.reason, r.custom_reason, 'Policy violation') as reason,
        r.status,
        COALESCE(u.account_name, u.full_name, 'Anonymous') as "reportedBy",
        r.reporter_id as "reporterId",
        '100%' as "repScore",
        CASE 
          WHEN r.target_type = 'USER' THEN target_u.user_id
          WHEN r.target_type IN ('Content', 'POST') THEN p.author_id
          WHEN r.target_type IN ('COMMENT', 'THOUGHT') THEN pc.author_id
          ELSE NULL
        END as "targetUserId",
        CASE 
          WHEN r.target_type = 'USER' THEN COALESCE(target_u.account_name, target_u.full_name)
          WHEN r.target_type IN ('Content', 'POST') THEN COALESCE(pu.account_name, pu.full_name, po.name)
          WHEN r.target_type IN ('COMMENT', 'THOUGHT') THEN COALESCE(cu.account_name, cu.full_name)
          ELSE 'Unknown'
        END as "targetUserName",
        (SELECT url FROM post_media pm WHERE pm.post_id::text = r.target_id::text LIMIT 1) AS "postImageUrl",
        (SELECT media_type FROM post_media pm WHERE pm.post_id::text = r.target_id::text LIMIT 1) AS "postMediaType",
        (SELECT json_agg(po2.option_text) FROM post_polls pp JOIN poll_options po2 ON pp.poll_id = po2.poll_id WHERE pp.post_id::text = r.target_id::text) AS "pollOptions",
        (SELECT json_agg(json_build_object('id', rn.id, 'message', rn.message, 'createdAt', rn.created_at)) FROM report_review_notes rn WHERE rn.report_id = r.id) AS "reviewNotes",
        (
          SELECT json_build_object(
            'actionType', aa.action_type,
            'customReason', aa.custom_reason,
            'moderatorNote', aa.moderator_note,
            'createdAt', aa.created_at,
            'durationDays', aa.duration_days
          )
          FROM account_actions aa
          WHERE (aa.affected_id::text = r.target_id::text OR aa.user_id = (
            CASE 
              WHEN r.target_type = 'USER' THEN target_u.user_id
              WHEN r.target_type IN ('Content', 'POST') THEN p.author_id
              WHEN r.target_type IN ('COMMENT', 'THOUGHT') THEN pc.author_id
              ELSE NULL
            END
          ))
          ORDER BY aa.created_at DESC
          LIMIT 1
        ) AS "accountAction"
      ${baseJoin}
      ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT ${queryParams.length + 1} OFFSET ${queryParams.length + 2}
    `;

    const result = await req.db.query(query, [...queryParams, limit, offset]);

    res.json({
      reports: result.rows,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / limit) || 1
    });
  } catch (err) {
    console.error('Error fetching reports:', err);
    res.status(500).json({ error: 'Server error fetching reports' });
  }
};

exports.updateReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body; // 'escalated', 'resolved', 'dismissed', 'action_taken'

    if (!status) return res.status(400).json({ error: 'Status is required' });

    let finalStatus = status;
    if (status === 'resolved') finalStatus = 'action_taken';

    const result = await req.db.query(
      'UPDATE reports SET status = $1, resolved_at = NOW() WHERE id = $2 RETURNING *',
      [finalStatus, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const adminId = req.user?.userId || null;
    let noteMessage = note;
    if (!noteMessage) {
      if (finalStatus === 'dismissed' || finalStatus === 'no_action') {
        noteMessage = 'Our moderation team reviewed your report and found that the content does not violate our community standards. No action was taken.';
      } else if (finalStatus === 'action_taken') {
        noteMessage = 'Our moderation team reviewed your report and took action regarding the reported content.';
      }
    }

    if (noteMessage && (finalStatus === 'dismissed' || finalStatus === 'action_taken' || finalStatus === 'no_action')) {
      await req.db.query(
        'INSERT INTO report_review_notes (report_id, message, is_system, created_by) VALUES ($1, $2, false, $3)',
        [id, noteMessage, adminId]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating report:', err);
    res.status(500).json({ error: 'Server error updating report' });
  }
};

exports.getAppeals = async (req, res) => {
  try {
    const { status = 'pending' } = req.query;

    const query = `
      SELECT 
        a.appeal_id as id,
        u.full_name as user,
        'Content' as type,
        'Original Violation' as "originalViolation",
        'System' as "suspendingAdmin",
        a.appeal_reason as "appealText",
        a.created_at as "appealTime"
      FROM post_appeals a
      LEFT JOIN users u ON a.user_id = u.user_id
      WHERE a.status = $1
      ORDER BY a.created_at DESC
    `;
    const result = await req.db.query(query, [status]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching appeals:', err);
    res.status(500).json({ error: 'Server error fetching appeals' });
  }
};

exports.updateAppeal = async (req, res) => {
  const client = await req.db.connect();
  try {
    const { id } = req.params;
    const { action } = req.body; // 'reinstate', 'reinstate_with_warning', 'uphold'

    const validActions = ['reinstate', 'reinstate_with_warning', 'uphold'];
    if (!action || !validActions.includes(action)) {
      return res.status(400).json({ error: `Action must be one of: ${validActions.join(', ')}` });
    }

    await client.query('BEGIN');

    // Step 1: Fetch the appeal and linked post/user
    const appealResult = await client.query(
      'SELECT appeal_id, post_id, user_id FROM post_appeals WHERE appeal_id = $1',
      [id]
    );

    if (appealResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Appeal not found' });
    }

    const { post_id, user_id } = appealResult.rows[0];

    // Step 2: Execute side-effects based on action
    if (action === 'reinstate') {
      // Restore the post to the feed
      await client.query(
        'UPDATE posts SET is_deleted = false, is_unlisted = false, is_removed = false, visibility = $2 WHERE post_id = $1',
        [post_id, 'public']
      );

    } else if (action === 'reinstate_with_warning') {
      // Restore the post
      await client.query(
        'UPDATE posts SET is_deleted = false, is_unlisted = false, is_removed = false, visibility = $2 WHERE post_id = $1',
        [post_id, 'public']
      );
      // Increment the user's moderation flag count
      await client.query(
        'UPDATE users SET moderation_flags = moderation_flags + 1 WHERE user_id = $1',
        [user_id]
      );
      // Log a formal warning in the user_warnings table
      await client.query(
        `INSERT INTO user_warnings (user_id, reason, message, is_severe)
         VALUES ($1, 'Post Warning', 'Your post was reinstated, but it was flagged as violating community guidelines. Further violations may result in permanent removal.', false)`,
        [user_id]
      );

    } else if (action === 'uphold') {
      // No changes to the post — the removal stands.
      // Just mark the appeal as rejected below.
    }

    // Step 3: Update the appeal status
    const finalStatus = (action === 'uphold') ? 'rejected' : 'approved';
    const updated = await client.query(
      'UPDATE post_appeals SET status = $1, reviewed_at = NOW() WHERE appeal_id = $2 RETURNING *',
      [finalStatus, id]
    );

    // Notify Main API to emit Socket.io notification
    try {
      await fetch('http://localhost:5000/internal/v1/appeals/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_API_SECRET
        },
        body: JSON.stringify({
          userId: user_id,
          postId: post_id,
          status: finalStatus,
          reason: action === 'uphold' ? 'Admin rejected your appeal' : 'Admin approved your appeal'
        })
      });
    } catch (notifyErr) {
      console.error('Failed to notify Main API for appeal resolution:', notifyErr);
    }

    await client.query('COMMIT');
    res.json(updated.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating appeal:', err);
    res.status(500).json({ error: 'Server error updating appeal' });
  } finally {
    client.release();
  }
};

exports.deleteReportedPost = async (req, res) => {
  try {
    const { id } = req.params;

    // Soft delete the post
    const updateRes = await req.db.query(
      'UPDATE posts SET is_deleted = true WHERE post_id = $1 RETURNING author_id, content',
      [id]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const authorId = updateRes.rows[0]?.author_id;
    const postContent = updateRes.rows[0]?.content;
    const adminId = req.user?.userId || null;

    if (authorId) {
      await req.db.query(
        `INSERT INTO account_actions (
          user_id, action_type, custom_reason, moderator_note,
          affected_type, affected_id, affected_title, status, issued_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          authorId,
          'post_removed',
          'Community Guidelines Violation',
          'Your post was removed for violating community guidelines.',
          'POST',
          id,
          postContent ? (postContent.length > 80 ? postContent.slice(0, 80) + '...' : postContent) : 'Content',
          'active',
          adminId
        ]
      );
    }

    // Automatically resolve all active/escalated reports targeting this post
    const reportRes = await req.db.query(
      "UPDATE reports SET status = 'action_taken', resolved_at = NOW() WHERE target_type IN ('Content', 'POST') AND target_id::text = $1::text AND status IN ('active', 'pending', 'escalated') RETURNING id",
      [id]
    );

    for (const r of reportRes.rows) {
      await req.db.query(
        'INSERT INTO report_review_notes (report_id, message, is_system, created_by) VALUES ($1, $2, false, $3)',
        [r.id, 'Our moderation team reviewed your report and removed the reported content for violating community guidelines.', adminId]
      );
    }

    res.json({ message: 'Post deleted successfully and associated reports resolved.' });
  } catch (err) {
    console.error('Error deleting post:', err);
    res.status(500).json({ error: 'Server error deleting post' });
  }
};

exports.deleteReportedComment = async (req, res) => {
  try {
    const { id } = req.params;

    // Soft delete the comment
    const updateRes = await req.db.query(
      'UPDATE post_comments SET is_deleted = true WHERE comment_id = $1 RETURNING author_id, content',
      [id]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    const authorId = updateRes.rows[0]?.author_id;
    const commentContent = updateRes.rows[0]?.content;
    const adminId = req.user?.userId || null;

    if (authorId) {
      await req.db.query(
        `INSERT INTO account_actions (
          user_id, action_type, custom_reason, moderator_note,
          affected_type, affected_id, affected_title, status, issued_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          authorId,
          'comment_removed',
          'Community Guidelines Violation',
          'Your comment was removed for violating community guidelines.',
          'COMMENT',
          id,
          commentContent ? (commentContent.length > 80 ? commentContent.slice(0, 80) + '...' : commentContent) : 'Comment',
          'active',
          adminId
        ]
      );
    }

    // Automatically resolve all active/escalated reports targeting this comment
    const reportRes = await req.db.query(
      "UPDATE reports SET status = 'action_taken', resolved_at = NOW() WHERE target_type IN ('COMMENT', 'THOUGHT') AND target_id::text = $1::text AND status IN ('active', 'pending', 'escalated') RETURNING id",
      [id]
    );

    for (const r of reportRes.rows) {
      await req.db.query(
        'INSERT INTO report_review_notes (report_id, message, is_system, created_by) VALUES ($1, $2, false, $3)',
        [r.id, 'Our moderation team reviewed your report and removed the reported comment for violating community guidelines.', adminId]
      );
    }

    res.json({ message: 'Comment deleted successfully and associated reports resolved.' });
  } catch (err) {
    console.error('Error deleting comment:', err);
    res.status(500).json({ error: 'Server error deleting comment' });
  }
};

exports.exportMarketingProfilesReport = async (req, res) => {
  try {
    const { format = 'csv', status = 'All', role = 'All', college = 'All', search = '', startDate, endDate } = req.query;

    let whereConditions = [];
    let queryParams = [];

    // Filter by User Status
    if (status && status !== 'All') {
      if (status === 'Active') {
        whereConditions.push('u.is_suspended = false AND u.is_deleted = false');
      } else if (status === 'Suspended') {
        whereConditions.push('u.is_suspended = true');
      } else if (status === 'Deleted') {
        whereConditions.push('u.is_deleted = true');
      }
    }

    // Filter by Account Type / Role
    if (role && role !== 'All') {
      queryParams.push(role);
      whereConditions.push(`COALESCE(p.account_type, u.user_type, 'Working Professional') = $${queryParams.length}`);
    }

    // Filter by College / Institution
    if (college && college !== 'All') {
      queryParams.push(college);
      whereConditions.push(`EXISTS (
        SELECT 1 FROM educations ed 
        WHERE ed.profile_id = p.profile_id 
          AND LOWER(TRIM(ed.school_name)) = LOWER(TRIM($${queryParams.length}))
      )`);
    }

    // Search Filter
    if (search) {
      queryParams.push(`%${search}%`);
      const searchIdx = queryParams.length;
      whereConditions.push(`(u.email ILIKE $${searchIdx} OR u.full_name ILIKE $${searchIdx} OR u.location ILIKE $${searchIdx} OR u.headline ILIKE $${searchIdx})`);
    }

    // Date Range Filter
    if (startDate) {
      queryParams.push(startDate);
      whereConditions.push(`u.created_at >= $${queryParams.length}`);
    }
    if (endDate) {
      queryParams.push(endDate);
      whereConditions.push(`u.created_at <= $${queryParams.length}`);
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    const query = `
      SELECT 
        u.user_id AS id,
        u.full_name,
        u.email,
        u.mobile_number,
        u.headline,
        (SELECT e.title FROM experiences e WHERE e.profile_id = p.profile_id ORDER BY e.is_current DESC, e.start_date DESC NULLS LAST LIMIT 1) AS job_title,
        (SELECT e.company_name FROM experiences e WHERE e.profile_id = p.profile_id ORDER BY e.is_current DESC, e.start_date DESC NULLS LAST LIMIT 1) AS company_name,
        (SELECT ed.school_name FROM educations ed WHERE ed.profile_id = p.profile_id ORDER BY ed.start_date DESC NULLS LAST LIMIT 1) AS school,
        (SELECT ed.degree FROM educations ed WHERE ed.profile_id = p.profile_id ORDER BY ed.start_date DESC NULLS LAST LIMIT 1) AS degree,
        COALESCE(u.location_formatted, u.location, CONCAT_WS(', ', u.location_city, u.location_state, u.location_country)) AS location,
        u.about_text,
        u.created_at AS joined_at,
        u.is_suspended,
        u.is_deleted,
        
        p.account_type,
        p.working_industry AS industry,
        p.open_to,
        p.availability,
        p.work_preference,

        -- Aggregated Experiences
        COALESCE(
          (SELECT json_agg(json_build_object(
            'title', e.title,
            'company_name', e.company_name,
            'location', e.location,
            'work_type', e.work_type,
            'work_mode', e.work_mode,
            'start_date', e.start_date,
            'end_date', e.end_date,
            'is_current', e.is_current,
            'description', e.description
          ) ORDER BY e.is_current DESC, e.start_date DESC)
           FROM experiences e WHERE e.profile_id = p.profile_id),
          '[]'::json
        ) AS experiences,

        -- Aggregated Educations
        COALESCE(
          (SELECT json_agg(json_build_object(
            'school_name', ed.school_name,
            'degree', ed.degree,
            'field_of_study', ed.field_of_study,
            'location', ed.location,
            'start_date', ed.start_date,
            'end_date', ed.end_date,
            'description', ed.description
          ) ORDER BY ed.start_date DESC)
           FROM educations ed WHERE ed.profile_id = p.profile_id),
          '[]'::json
        ) AS educations,

        -- Aggregated Skills
        COALESCE(
          (SELECT json_agg(s.name)
           FROM user_skills us JOIN skills s ON us.skill_id = s.skill_id
           WHERE us.profile_id = p.profile_id),
          '[]'::json
        ) AS skills,

        -- Aggregated Projects
        COALESCE(
          (SELECT json_agg(json_build_object(
            'title', pr.title,
            'role', pr.role,
            'organization', pr.organization,
            'details', pr.details,
            'start_year', pr.start_year,
            'end_year', pr.end_year
          ) ORDER BY pr.created_at DESC)
           FROM projects pr WHERE pr.profile_id = p.profile_id),
          '[]'::json
        ) AS projects

      FROM users u
      LEFT JOIN profiles p ON u.user_id = p.user_id
      ${whereClause}
      ORDER BY u.created_at DESC
    `;

    const result = await req.db.query(query, queryParams);
    const users = result.rows;

    const formatExperiences = (exps) => {
      if (!Array.isArray(exps) || exps.length === 0) return 'N/A';
      return exps.map(e => {
        const company = e.company_name || 'N/A';
        const title = e.title || 'N/A';
        const type = e.work_type ? ` (${e.work_type})` : '';
        const dates = e.is_current ? `${e.start_date ? new Date(e.start_date).toISOString().split('T')[0] : ''} - Present` : `${e.start_date ? new Date(e.start_date).toISOString().split('T')[0] : ''} - ${e.end_date ? new Date(e.end_date).toISOString().split('T')[0] : ''}`;
        return `${title} at ${company}${type} [${dates}]`;
      }).join(' | ');
    };

    const formatEducations = (eds) => {
      if (!Array.isArray(eds) || eds.length === 0) return 'N/A';
      return eds.map(e => {
        const school = e.school_name || 'N/A';
        const degree = e.degree ? `${e.degree}` : '';
        const field = e.field_of_study ? ` in ${e.field_of_study}` : '';
        const dates = `${e.start_date ? new Date(e.start_date).toISOString().split('T')[0] : ''} - ${e.end_date ? new Date(e.end_date).toISOString().split('T')[0] : ''}`;
        return `${degree}${field} from ${school} [${dates}]`;
      }).join(' | ');
    };

    const formatSkills = (sk) => {
      if (!Array.isArray(sk) || sk.length === 0) return 'N/A';
      return sk.join(', ');
    };

    const formatProjects = (prs) => {
      if (!Array.isArray(prs) || prs.length === 0) return 'N/A';
      return prs.map(p => {
        const title = p.title || 'N/A';
        const role = p.role ? ` (${p.role})` : '';
        return `${title}${role}`;
      }).join(' | ');
    };

    if (format === 'json') {
      return res.json({
        total: users.length,
        exported_at: new Date().toISOString(),
        users
      });
    }

    if (format === 'pdf') {
      let puppeteer;
      try {
        puppeteer = require('puppeteer');
      } catch (pErr) {
        puppeteer = null;
      }
      const userCardsHtml = users.map((u) => {
        let statusClass = 'status-active';
        let statusText = 'Active';
        if (u.is_deleted) { statusClass = 'status-deleted'; statusText = 'Deleted'; }
        else if (u.is_suspended) { statusClass = 'status-suspended'; statusText = 'Suspended'; }

        const expText = formatExperiences(u.experiences);
        const eduText = formatEducations(u.educations);
        const skillsText = formatSkills(u.skills);
        const projText = formatProjects(u.projects);

        return `
          <div class="user-card">
            <div class="user-header">
              <div>
                <span class="user-name">${u.full_name || 'Unnamed User'}</span>
                <span class="user-email">(${u.email || 'No email'})</span>
              </div>
              <span class="badge ${statusClass}">${statusText}</span>
            </div>
            
            <div class="user-meta">
              <div><strong>Account Type:</strong> ${u.account_type || u.user_type || 'Working Professional'}</div>
              <div><strong>Industry:</strong> ${u.industry || 'N/A'}</div>
              <div><strong>Location:</strong> ${u.location || 'N/A'}</div>
              <div><strong>Mobile:</strong> ${u.mobile_number || 'N/A'}</div>
              <div><strong>Headline:</strong> ${u.headline || 'N/A'}</div>
              <div><strong>Job & Company:</strong> ${u.job_title || ''} ${u.company_name ? `@ ${u.company_name}` : ''}</div>
            </div>

            <div class="section">
              <div class="section-title">🎓 Education</div>
              <div class="section-content">${eduText}</div>
            </div>

            <div class="section">
              <div class="section-title">💼 Experience</div>
              <div class="section-content">${expText}</div>
            </div>

            <div class="section">
              <div class="section-title">⚡ Skills</div>
              <div class="section-content">${skillsText}</div>
            </div>

            ${projText !== 'N/A' ? `
            <div class="section">
              <div class="section-title">🚀 Projects</div>
              <div class="section-content">${projText}</div>
            </div>` : ''}
          </div>
        `;
      }).join('');

      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Cocpit User Marketing Profiles Report</title>
          <style>
            @page { size: A4 portrait; margin: 12mm; }
            body {
              font-family: 'Segoe UI', Helvetica, Arial, sans-serif;
              color: #1e293b;
              margin: 0;
              padding: 0;
              background: #fff;
              font-size: 11px;
              line-height: 1.4;
            }
            .header {
              text-align: center;
              border-bottom: 2px solid #4f46e5;
              padding-bottom: 10px;
              margin-bottom: 16px;
            }
            .header h1 {
              color: #4f46e5;
              font-size: 20px;
              margin: 0 0 4px 0;
            }
            .header p {
              color: #64748b;
              margin: 0;
              font-size: 11px;
            }
            .user-card {
              border: 1px solid #cbd5e1;
              border-radius: 6px;
              padding: 10px 14px;
              margin-bottom: 14px;
              page-break-inside: avoid;
              background-color: #f8fafc;
            }
            .user-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              border-bottom: 1px solid #e2e8f0;
              padding-bottom: 4px;
              margin-bottom: 6px;
            }
            .user-name {
              font-size: 14px;
              font-weight: bold;
              color: #0f172a;
            }
            .user-email {
              font-size: 11px;
              color: #64748b;
              margin-left: 6px;
            }
            .badge {
              padding: 2px 8px;
              border-radius: 12px;
              font-size: 9px;
              font-weight: bold;
              text-transform: uppercase;
            }
            .status-active { background: #dcfce7; color: #166534; }
            .status-suspended { background: #fee2e2; color: #991b1b; }
            .status-deleted { background: #f3f4f6; color: #4b5563; }
            .user-meta {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 2px 12px;
              font-size: 10px;
              color: #334155;
              margin-bottom: 6px;
            }
            .section {
              margin-top: 4px;
            }
            .section-title {
              font-weight: bold;
              color: #4338ca;
              font-size: 10px;
              margin-bottom: 2px;
            }
            .section-content {
              font-size: 10px;
              color: #475569;
              background: #ffffff;
              padding: 4px 8px;
              border-radius: 4px;
              border: 1px solid #e2e8f0;
            }
            .footer {
              text-align: center;
              font-size: 9px;
              color: #94a3b8;
              margin-top: 20px;
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>COCPIT — Marketing Profiles PDF Report</h1>
            <p>Generated on ${new Date().toLocaleDateString('en-US', { dateStyle: 'full' })} | Total Profiles: ${users.length}</p>
          </div>
          ${userCardsHtml}
          <div class="footer">
            Confidential — Internal Marketing Campaign Report — Generated by Cocpit Admin Panel
          </div>
        </body>
        </html>
      `;

      if (!puppeteer) {
        // Puppeteer is not installed in the environment; return printable HTML with automatic print trigger
        const printableHtml = htmlContent.replace('</body>', '<script>window.onload = () => { window.print(); };</script></body>');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(printableHtml);
      }

      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });

      try {
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '0.4in', right: '0.4in', bottom: '0.4in', left: '0.4in' }
        });

        const fileName = `cocpit_marketing_profiles_${new Date().toISOString().split('T')[0]}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        return res.send(pdfBuffer);
      } finally {
        await browser.close();
      }
    }

    const headers = [
      'User ID',
      'Full Name',
      'Email',
      'Mobile Number',
      'Status',
      'Account Type / Role',
      'Working Industry',
      'Headline',
      'Current Job Title',
      'Current Company',
      'Location',
      'Joined Date',
      'Open To',
      'Availability',
      'Work Preference',
      'Skills',
      'Education Details',
      'Experience Details',
      'Projects Details'
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const csvRows = [headers.map(escapeCsv).join(',')];

    for (const u of users) {
      let userStatus = 'Active';
      if (u.is_deleted) userStatus = 'Deleted';
      else if (u.is_suspended) userStatus = 'Suspended';

      const row = [
        u.id,
        u.full_name || '',
        u.email || '',
        u.mobile_number || '',
        userStatus,
        u.account_type || u.user_type || 'Working Professional',
        u.industry || '',
        u.headline || '',
        u.job_title || '',
        u.company_name || '',
        u.location || '',
        u.joined_at ? new Date(u.joined_at).toISOString().split('T')[0] : '',
        u.open_to || '',
        u.availability || '',
        u.work_preference || '',
        formatSkills(u.skills),
        formatEducations(u.educations),
        formatExperiences(u.experiences),
        formatProjects(u.projects)
      ];

      csvRows.push(row.map(escapeCsv).join(','));
    }

    const csvData = csvRows.join('\n');
    const fileName = `cocpit_marketing_users_report_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.status(200).send(csvData);

  } catch (err) {
    console.error('Error exporting marketing profiles report:', err);
    res.status(500).json({ error: 'Server error generating profile report export' });
  }
};

