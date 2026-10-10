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
      queryParams.push(status);
      whereConditions.push(`status = $${queryParams.length}`);
    }

    if (type && type !== 'All') {
      queryParams.push(type);
      whereConditions.push(`target_type = $${queryParams.length}`);
    }
    if (reason && reason !== 'All') {
      queryParams.push(reason);
      whereConditions.push(`reason = $${queryParams.length}`);
    }
    if (severity && severity !== 'All') {
      queryParams.push(severity);
      whereConditions.push(`severity = $${queryParams.length}`);
    }
    if (targetUserId) {
      queryParams.push(targetUserId);
      whereConditions.push(`target_user_id = $${queryParams.length}`);
    }
    if (reporterId) {
      queryParams.push(reporterId);
      whereConditions.push(`reporter_id = $${queryParams.length}`);
    }

    let whereClause = whereConditions.length > 0 ? `WHERE ` + whereConditions.join(' AND ') : '';

    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) FROM admin_reports_view ${whereClause}`;
    const countResult = await req.db.query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count, 10);

    const query = `
      SELECT 
        id,
        target_type as type,
        raw_target_type as "rawType",
        severity,
        offenses,
        content_preview as "contentPreview",
        image_url as "image",
        created_at as "postTime",
        target_id as "postId",
        reason,
        reported_by as "reportedBy",
        reporter_id as "reporterId",
        '100%' as "repScore", -- Mock rep score for now
        target_user_id as "targetUserId",
        target_user_name as "targetUserName",
        (SELECT url FROM post_media pm WHERE pm.post_id = target_id LIMIT 1) AS "postImageUrl",
        (SELECT media_type FROM post_media pm WHERE pm.post_id = target_id LIMIT 1) AS "postMediaType",
        (SELECT json_agg(po.option_text) FROM post_polls pp JOIN poll_options po ON pp.poll_id = po.poll_id WHERE pp.post_id = target_id) AS "pollOptions"
      FROM admin_reports_view
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
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
    const { status } = req.body; // 'escalated', 'resolved', 'dismissed'

    if (!status) return res.status(400).json({ error: 'Status is required' });

    const result = await req.db.query(
      'UPDATE reports SET status = $1, resolved_at = NOW() WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
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
      'UPDATE posts SET is_deleted = true WHERE post_id = $1 RETURNING *',
      [id]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Automatically resolve all active/escalated reports targeting this post
    await req.db.query(
      "UPDATE reports SET status = 'resolved', resolved_at = NOW() WHERE target_type IN ('Content', 'POST', 'COMMENT') AND target_id = $1 AND status IN ('active', 'escalated')",
      [id]
    );

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
      'UPDATE post_comments SET is_deleted = true WHERE comment_id = $1 RETURNING *',
      [id]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    // Automatically resolve all active/escalated reports targeting this comment
    await req.db.query(
      "UPDATE reports SET status = 'resolved', resolved_at = NOW() WHERE target_type IN ('Content', 'POST', 'COMMENT') AND target_id = $1 AND status IN ('active', 'escalated')",
      [id]
    );

    res.json({ message: 'Comment deleted successfully and associated reports resolved.' });
  } catch (err) {
    console.error('Error deleting comment:', err);
    res.status(500).json({ error: 'Server error deleting comment' });
  }
};

exports.exportMarketingProfilesReport = async (req, res) => {
  try {
    const { format = 'csv', status = 'All', role = 'All', search = '', startDate, endDate } = req.query;

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

    // Search Filter
    if (search) {
      queryParams.push(`%${search}%`);
      const searchIdx = queryParams.length;
      whereConditions.push(`(u.email ILIKE $${searchIdx} OR u.full_name ILIKE $${searchIdx} OR u.location ILIKE $${searchIdx} OR u.headline ILIKE $${searchIdx} OR u.company_name ILIKE $${searchIdx} OR u.school ILIKE $${searchIdx})`);
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
        u.job_title,
        u.company_name,
        u.school,
        u.degree,
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
      const puppeteer = require('puppeteer');
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

