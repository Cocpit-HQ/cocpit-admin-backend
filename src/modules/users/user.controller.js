const { pool } = require('../../config/db');
const redis = require('../../config/redis');
const crypto = require('crypto');
const { sendSuspensionAppealEmail } = require('../../services/email.service');
const socketService = require('../../services/socketBridge');

exports.getUserRoles = async (req, res) => {
  try {
    const query = `
      SELECT DISTINCT account_type AS role FROM profiles WHERE account_type IS NOT NULL
      UNION
      SELECT DISTINCT user_type AS role FROM users WHERE user_type IS NOT NULL
      ORDER BY role
    `;
    const result = await req.db.query(query);
    res.json(result.rows.map(row => row.role));
  } catch (err) {
    console.error('Error fetching user roles:', err);
    res.status(500).json({ error: 'Server error fetching roles' });
  }
};

exports.getColleges = async (req, res) => {
  try {
    const query = `
      SELECT DISTINCT TRIM(school_name) AS college
      FROM educations
      WHERE school_name IS NOT NULL AND TRIM(school_name) <> ''
      ORDER BY college ASC
    `;
    const result = await req.db.query(query);
    res.json(result.rows.map(row => row.college));
  } catch (err) {
    console.error('Error fetching colleges:', err);
    res.status(500).json({ error: 'Server error fetching colleges' });
  }
};

exports.getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 8; // Match frontend's 8 items per page
    const offset = (page - 1) * limit;

    const search = req.query.search || '';
    const status = req.query.status || 'All';
    const roleFilter = req.query.role || 'All';
    const collegeFilter = req.query.college || 'All';
    const onboardingFilter = req.query.onboarding || 'All';

    let baseQuery = 'FROM users u LEFT JOIN profiles p ON u.user_id = p.user_id WHERE 1=1';
    let queryParams = [];

    // Status Filter
    if (status !== 'All') {
      if (status === 'Active') {
        baseQuery += ' AND u.is_suspended = false AND u.is_deleted = false';
      } else if (status === 'Suspended') {
        baseQuery += ' AND u.is_suspended = true';
      } else if (status === 'Deleted') {
        baseQuery += ' AND u.is_deleted = true';
      }
    }

    // Onboarding Filter
    if (onboardingFilter !== 'All') {
      if (onboardingFilter.toLowerCase() === 'completed') {
        baseQuery += ' AND u.is_onboarding_complete = true';
      } else if (onboardingFilter.toLowerCase() === 'incomplete') {
        baseQuery += ' AND (u.is_onboarding_complete = false OR u.is_onboarding_complete IS NULL)';
      }
    }

    // Role Filter
    if (roleFilter !== 'All') {
      queryParams.push(roleFilter);
      const roleParamIndex = queryParams.length;
      baseQuery += ` AND COALESCE(p.account_type, u.user_type, 'Working Professional') = $${roleParamIndex}`;
    }

    // College / Institution Filter
    if (collegeFilter && collegeFilter !== 'All') {
      queryParams.push(collegeFilter);
      const collegeParamIndex = queryParams.length;
      baseQuery += ` AND EXISTS (
        SELECT 1 FROM educations ed 
        WHERE ed.profile_id = p.profile_id 
          AND LOWER(TRIM(ed.school_name)) = LOWER(TRIM($${collegeParamIndex}))
      )`;
    }

    // Search Filter
    if (search) {
      queryParams.push(`%${search}%`);
      const searchParamIndex = queryParams.length;
      baseQuery += ` AND (u.email ILIKE $${searchParamIndex} OR u.full_name ILIKE $${searchParamIndex} OR u.user_id::text ILIKE $${searchParamIndex})`;
    }

    // Date Range Filter
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    if (startDate) {
      queryParams.push(startDate);
      const startParamIndex = queryParams.length;
      baseQuery += ` AND u.created_at >= $${startParamIndex}`;
    }
    if (endDate) {
      queryParams.push(endDate);
      const endParamIndex = queryParams.length;
      baseQuery += ` AND u.created_at <= $${endParamIndex}`;
    }

    // Get Total Count for Pagination
    const countQuery = `SELECT COUNT(*) ${baseQuery}`;
    const countResult = await req.db.query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit) || 1;

    // Get Overall Stats for Cards
    const statsQuery = `
      SELECT 
        COUNT(*) as total_users,
        COUNT(*) FILTER (WHERE is_suspended = false AND is_deleted = false) as active_users,
        COUNT(*) FILTER (WHERE is_suspended = true) as suspended_users,
        COUNT(*) FILTER (WHERE is_onboarding_complete = true) as onboarding_complete
      FROM users
    `;
    const statsResult = await req.db.query(statsQuery);
    const stats = {
      totalUsers: parseInt(statsResult.rows[0].total_users),
      activeUsers: parseInt(statsResult.rows[0].active_users),
      suspendedUsers: parseInt(statsResult.rows[0].suspended_users),
      onboardingComplete: parseInt(statsResult.rows[0].onboarding_complete) || 0,
    };

    // Get Paginated Data
    const dataQuery = `
      SELECT 
        u.user_id,
        u.full_name,
        u.email,
        u.user_type,
        p.account_type,
        u.is_suspended,
        u.is_deleted,
        u.is_onboarding_complete,
        u.onboarding_step,
        u.avatar_url,
        u.created_at,
        (SELECT ed.school_name FROM educations ed WHERE ed.profile_id = p.profile_id ORDER BY ed.start_date DESC NULLS LAST LIMIT 1) AS college
      ${baseQuery}
      ORDER BY u.created_at DESC
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
    `;

    const paginatedParams = [...queryParams, limit, offset];
    const { rows } = await req.db.query(dataQuery, paginatedParams);

    const formattedUsers = rows.map(user => {
      // Calculate initials
      let initials = 'U';
      if (user.full_name) {
        const parts = user.full_name.trim().split(' ');
        if (parts.length > 1) {
          initials = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        } else if (parts.length === 1 && parts[0]) {
          initials = parts[0].substring(0, 2).toUpperCase();
        }
      }

      // Determine status
      let userStatus = 'Active';
      if (user.is_deleted) {
        userStatus = 'Deleted';
      } else if (user.is_suspended) {
        userStatus = 'Suspended';
      }

      // Map user_type to role if needed (default to Working Professional if missing)
      const role = user.account_type || user.user_type || 'Working Professional';

      return {
        id: user.user_id,
        initials,
        name: user.full_name || 'Incomplete Profile',
        email: user.email,
        role: role,
        college: user.college || null,
        status: userStatus,
        isOnboardingComplete: Boolean(user.is_onboarding_complete),
        onboardingStep: user.onboarding_step,
        avatar: user.avatar_url,
        joined: user.created_at
      };
    });

    res.json({
      data: formattedUsers,
      total,
      page,
      totalPages,
      limit,
      stats
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

exports.getUserDetails = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Basic User Info
    const userQuery = `
      SELECT user_id, full_name, email, mobile_number, headline, about_text,
             location_formatted, location_city, location_state, location_country, location,
             location_lat, location_lng,
             avatar_url, created_at, user_type, is_suspended, is_deleted, last_active_at, moderation_flags,
             suspension_count, is_onboarding_complete, onboarding_step
      FROM users WHERE user_id = $1
    `;
    const userResult = await req.db.query(userQuery, [id]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    // 2. Stats
    const statsQuery = `
      SELECT 
        (SELECT count(*) FROM posts WHERE author_id = $1) as posts_count,
        (SELECT count(*) FROM followers WHERE following_id = $1) as followers_count,
        (SELECT count(*) FROM followers WHERE follower_id = $1) as following_count,
        (SELECT count(*) FROM connections WHERE user_id = $1 OR connected_user_id = $1) as connections_count,
        (SELECT count(*) FROM reports WHERE target_id = $1) as flags_count
    `;
    const statsResult = await req.db.query(statsQuery, [id]);
    const stats = statsResult.rows[0];

    const activityQuery = `
      SELECT c.id, c.action_type, c.entity_type, c.created_at, c.entity_id, c.metadata,
             j.title AS job_title, j.job_id, c.post_content, c.post_media, c.target_user_name, c.target_user_avatar, c.post_created_at
      FROM (
        SELECT ual.id::text as id, ual.action_type, ual.entity_type, ual.created_at, ual.entity_id, ual.metadata, 
                p.content as post_content, 
                (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = p.post_id) as post_media,
                u.full_name as target_user_name,
                u.avatar_url as target_user_avatar,
                p.created_at as post_created_at
        FROM user_activity_log ual
        LEFT JOIN posts p ON ual.entity_type = 'post' AND ual.entity_id::text = p.post_id::text
        LEFT JOIN users u ON p.author_id = u.user_id
        WHERE ual.user_id = $1
        UNION ALL
        SELECT post_id::text as id, 'POST_CREATED' as action_type, 'post' as entity_type, created_at, NULL as entity_id, '{}'::jsonb as metadata,
                content as post_content, (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = posts.post_id) as post_media,
                (SELECT full_name FROM users WHERE user_id = posts.author_id) as target_user_name,
                (SELECT avatar_url FROM users WHERE user_id = posts.author_id) as target_user_avatar,
                created_at as post_created_at
        FROM posts 
        WHERE author_id = $1
      ) c
      LEFT JOIN jobs j ON c.entity_type = 'job' AND c.entity_id = j.job_id
      ORDER BY c.created_at DESC 
      LIMIT 15
    `;
    const activityResult = await req.db.query(activityQuery, [id]);

    // 4. Linked Accounts
    const socialQuery = `
      SELECT provider FROM user_social_accounts WHERE user_id = $1
    `;
    const socialResult = await req.db.query(socialQuery, [id]);

    // 5. Action History (Warnings)
    const warningsQuery = `
      SELECT warning_id as id, reason, message, is_severe, created_at 
      FROM user_warnings 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `;
    const warningsResult = await req.db.query(warningsQuery, [id]);

    // 6. Complete Profile Details (Education, Experience, Skills, Projects, Bio)
    let detailedProfile = {};
    try {
      const profileDetailsQuery = `
        SELECT 
          p.profile_id,
          p.account_type,
          p.working_industry,
          p.open_to,
          p.availability,
          p.work_preference,
          COALESCE(
            (SELECT json_agg(json_build_object(
              'school_name', ed.school_name,
              'degree', ed.degree,
              'field_of_study', ed.field_of_study,
              'location', ed.location,
              'start_date', ed.start_date,
              'end_date', ed.end_date,
              'description', ed.description
            ) ORDER BY ed.start_date DESC NULLS LAST)
             FROM educations ed WHERE ed.profile_id = p.profile_id),
            '[]'::json
          ) AS educations,
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
            ) ORDER BY e.is_current DESC, e.start_date DESC NULLS LAST)
             FROM experiences e WHERE e.profile_id = p.profile_id),
            '[]'::json
          ) AS experiences,
          COALESCE(
            (SELECT json_agg(s.name)
             FROM user_skills us JOIN skills s ON us.skill_id = s.skill_id
             WHERE us.profile_id = p.profile_id),
            '[]'::json
          ) AS skills,
          COALESCE(
            (SELECT json_agg(json_build_object(
              'title', pr.title,
              'role', pr.role,
              'organization', pr.organization,
              'details', pr.details,
              'start_year', pr.start_year,
              'end_year', pr.end_year
            ) ORDER BY pr.created_at DESC NULLS LAST)
             FROM projects pr WHERE pr.profile_id = p.profile_id),
            '[]'::json
          ) AS projects
        FROM profiles p
        WHERE p.user_id = $1
        LIMIT 1
      `;
      const profileDetailsResult = await req.db.query(profileDetailsQuery, [id]);
      if (profileDetailsResult.rows.length > 0) {
        detailedProfile = profileDetailsResult.rows[0];
      }
    } catch (profileErr) {
      console.error('Warning: could not fetch extended profile details:', profileErr.message);
    }

    // Formatting status and role
    let status = 'Active';
    if (user.is_deleted) status = 'Deleted';
    else if (user.is_suspended) status = 'Suspended';
    const role = detailedProfile.account_type || user.user_type || 'Working Professional';

    // Location Formatting
    let formattedLocation = user.location_formatted || user.location;
    if (!formattedLocation && (user.location_city || user.location_state || user.location_country)) {
      formattedLocation = [user.location_city, user.location_state, user.location_country]
        .filter(Boolean)
        .join(', ');
    }

    const profileData = {
      id: user.user_id,
      name: user.full_name,
      email: user.email,
      phone: user.mobile_number,
      location: formattedLocation || 'Unknown',
      coordinates: { lat: user.location_lat, lng: user.location_lng },
      avatar: user.avatar_url,
      joined: user.created_at,
      lastActive: user.last_active_at,
      status: status,
      role: role,
      isOnboardingComplete: Boolean(user.is_onboarding_complete),
      onboardingStep: user.onboarding_step,
      stats: {
        posts: parseInt(stats.posts_count),
        followers: parseInt(stats.followers_count),
        following: parseInt(stats.following_count),
        connections: parseInt(stats.connections_count || 0),
        flags: parseInt(stats.flags_count),
        moderation_flags: parseInt(user.moderation_flags || 0)
      },
      activities: activityResult.rows,
      actionHistory: warningsResult.rows,
      socialAccounts: socialResult.rows.map(r => r.provider),
      suspensionCount: parseInt(user.suspension_count || 0),
      detailedProfile: {
        headline: user.headline || '',
        about: user.about_text || '',
        industry: detailedProfile.working_industry || '',
        openTo: detailedProfile.open_to || '',
        availability: detailedProfile.availability || '',
        workPreference: detailedProfile.work_preference || '',
        resumeUrl: null,
        educations: detailedProfile.educations || [],
        experiences: detailedProfile.experiences || [],
        skills: detailedProfile.skills || [],
        projects: detailedProfile.projects || []
      }
    };

    res.json(profileData);
  } catch (error) {
    console.error('Error fetching user details:', error);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
};

exports.warnUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, message, isSevere, reportIds, postId, postTitle } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'Warning reason is required.' });
    }

    // Increment moderation flags by 1 if severe
    let points = 0;
    if (isSevere) {
      points = 1;
    }

    // Insert into user_warnings
    await req.db.query(
      'INSERT INTO user_warnings (user_id, reason, message, is_severe) VALUES ($1, $2, $3, $4)',
      [id, reason, message, isSevere]
    );

    await req.db.query(
      'INSERT INTO moderation_actions (target_type, target_id, action_type, reason, duration_days, performed_by) VALUES ($1, $2, $3, $4, $5, $6)',
      ['USER', id, 'WARNING', `${reason}. ${message || ''}`, null, req.user.userId]
    );

    // Insert into account_actions so it appears in in-app "Account actions" tab
    await req.db.query(
      `INSERT INTO account_actions (
        user_id, action_type, custom_reason, moderator_note,
        affected_type, affected_id, affected_title, status, issued_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        'warning',
        reason,
        message || 'Your account received an official warning for violating community guidelines.',
        postId ? 'POST' : 'USER',
        postId || id,
        postTitle || (postId ? 'Reported Content' : 'Account'),
        'active',
        null
      ]
    );

    // If report IDs are passed, resolve them and notify reporters
    if (Array.isArray(reportIds) && reportIds.length > 0) {
      await req.db.query(
        "UPDATE reports SET status = 'action_taken', resolved_at = NOW() WHERE id = ANY($1)",
        [reportIds]
      );
      for (const rId of reportIds) {
        await req.db.query(
          'INSERT INTO report_review_notes (report_id, message, is_system, created_by) VALUES ($1, $2, false, $3)',
          [rId, 'Our moderation team reviewed your report and took action: a formal warning was issued to the user.', null]
        );
      }
    }

    // Increment moderation flags
    const updateQuery = `
      UPDATE users 
      SET moderation_flags = COALESCE(moderation_flags, 0) + $2 
      WHERE user_id = $1 
      RETURNING moderation_flags, full_name
    `;
    const result = await req.db.query(updateQuery, [id, points]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const newFlagsCount = parseInt(result.rows[0].moderation_flags);
    const targetName = result.rows[0].full_name || 'user';
    const adminId = req.user.userId;
    let autoSuspended = false;

    if (newFlagsCount >= 7) {
      // Suspend and reset flags to 0
      await req.db.query(
        'UPDATE users SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE user_id = $1',
        [id]
      );
      autoSuspended = true;
      // Log suspension
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'USER_SUSPENDED', `Automatically suspended ${targetName} due to exceeding 7 moderation flags.`]
      );

      await req.db.query(
        'INSERT INTO moderation_actions (target_type, target_id, action_type, reason, duration_days, performed_by) VALUES ($1, $2, $3, $4, $5, $6)',
        ['USER', id, 'SUSPENSION', 'Auto-suspension for exceeding 7 moderation flags. Your account has been automatically suspended due to repeated violations.', 7, adminId]
      );

      await req.db.query(
        `INSERT INTO account_actions (
          user_id, action_type, custom_reason, moderator_note,
          affected_type, affected_id, affected_title, duration_days, expires_at, status, issued_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          'suspension',
          'Account Suspended',
          'Your account has been automatically suspended for 7 days due to repeated community guidelines violations.',
          'USER',
          id,
          'Account',
          7,
          new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          'active',
          null
        ]
      );

      // Notify Main API to kill active sessions and blacklist token
      await redis.publish('admin:users', JSON.stringify({ action: 'suspended', userId: id }));
      await redis.setex(`suspended_user:${id}`, 7 * 24 * 60 * 60, 'true'); // 7 days TTL
    }

    // Log the warning action to audit logs
    const actionDesc = isSevere
      ? `Issued a SEVERE warning to ${targetName} for: ${reason}`
      : `Issued a warning to ${targetName} for: ${reason}`;
    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'USER_WARNED', actionDesc]
    );

    // Notify the user via in-app notification database record and socket message
    const notificationText = isSevere 
      ? `Your account has been issued a severe warning for ${reason.toLowerCase()}.`
      : `Your account has been issued a warning for ${reason.toLowerCase()}.`;

    await req.db.query(`
      INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [id, null, 'user_warning', notificationText, id, JSON.stringify({ reason, message, isSevere, autoSuspended })]);

    socketService.notifyUser(id, "notification", {
      user_id: id,
      type: 'user_warning',
      text: notificationText,
      reference_id: id,
      created_at: new Date()
    });

    res.json({
      success: true,
      message: autoSuspended
        ? `${targetName} has been warned and automatically suspended (reached ${newFlagsCount} moderation flags).`
        : `Warning sent successfully. Moderation flags: ${newFlagsCount}.`,
      moderation_flags: newFlagsCount,
      autoSuspended
    });
  } catch (error) {
    console.error('Error warning user:', error);
    res.status(500).json({ error: 'Failed to warn user' });
  }
};

exports.suspendUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { duration, reportIds } = req.body;

    let suspendedUntil = null;
    if (duration === 'Short Temporary (3-7 days)') {
      suspendedUntil = new Date();
      suspendedUntil.setDate(suspendedUntil.getDate() + 7);
    } else if (duration === 'Long Temporary (30 days)') {
      suspendedUntil = new Date();
      suspendedUntil.setDate(suspendedUntil.getDate() + 30);
    }

    const result = await req.db.query(
      'UPDATE users SET is_suspended = true, suspended_until = $2, suspension_count = COALESCE(suspension_count, 0) + 1 WHERE user_id = $1 RETURNING full_name, email',
      [id, suspendedUntil]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetName = result.rows[0].full_name || 'user';
    const userEmail = result.rows[0].email;
    const adminId = req.user.userId;
    const suspensionDuration = duration || 'Indefinite';

    let durationDays = null;
    if (duration === 'Short Temporary (3-7 days)') durationDays = 7;
    else if (duration === 'Long Temporary (30 days)') durationDays = 30;

    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'USER_SUSPENDED', `Manually suspended ${targetName}. Duration: ${suspensionDuration}.`]
    );

    const actionRes = await req.db.query(
      'INSERT INTO moderation_actions (target_type, target_id, action_type, reason, duration_days, performed_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING action_id',
      ['USER', id, 'SUSPENSION', `Manual suspension by admin. Your account has been suspended. Duration: ${suspensionDuration}.`, durationDays, adminId]
    );

    // Insert into account_actions table
    await req.db.query(
      `INSERT INTO account_actions (
        user_id, action_type, custom_reason, moderator_note,
        affected_type, affected_id, affected_title, duration_days, expires_at, status, issued_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        'suspension',
        'Account Suspended',
        `Your account has been suspended by an administrator for ${suspensionDuration}.`,
        'USER',
        id,
        'Account',
        durationDays,
        suspendedUntil,
        'active',
        null
      ]
    );

    // If associated reports exist, mark them resolved
    if (Array.isArray(reportIds) && reportIds.length > 0) {
      await req.db.query(
        "UPDATE reports SET status = 'action_taken', resolved_at = NOW() WHERE id = ANY($1)",
        [reportIds]
      );
      for (const rId of reportIds) {
        await req.db.query(
          'INSERT INTO report_review_notes (report_id, message, is_system, created_by) VALUES ($1, $2, false, $3)',
          [rId, 'Our moderation team reviewed your report and took action: the reported user account has been suspended.', null]
        );
      }
    }

    const actionId = actionRes.rows[0].action_id;
    const appealToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await req.db.query(
      'INSERT INTO appeal_tokens (action_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [actionId, appealToken, expiresAt]
    );

    try {
      if (userEmail) {
        await sendSuspensionAppealEmail(userEmail, targetName, appealToken, `Manual suspension by admin for ${suspensionDuration}.`);
      }
    } catch (e) {
      console.error('Failed to send suspension email:', e);
    }

    // Notify Main API to kill active sessions and blacklist token
    await redis.publish('admin:users', JSON.stringify({ action: 'suspended', userId: id }));

    // Set TTL based on duration
    let ttlSeconds = 7 * 24 * 60 * 60; // default 7 days
    if (duration === 'Long Temporary (30 days)') ttlSeconds = 30 * 24 * 60 * 60;
    else if (duration === 'Indefinite' || !duration) ttlSeconds = 365 * 24 * 60 * 60; // 1 year

    await redis.setex(`suspended_user:${id}`, ttlSeconds, 'true');

    res.json({ success: true, message: 'User suspended successfully' });
  } catch (error) {
    console.error('Error suspending user:', error);
    res.status(500).json({ error: 'Failed to suspend user' });
  }
};

exports.bulkUnsuspendUsers = async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'No user IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of userIds) {
      const updateResult = await req.db.query(
        'UPDATE users SET is_suspended = false, moderation_flags = 0 WHERE user_id = $1 RETURNING full_name',
        [id]
      );

      if (updateResult.rows.length === 0) continue;

      const targetName = updateResult.rows[0].full_name || 'user';
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'USER_UNSUSPENDED', `Unsuspended ${targetName} (Bulk Action).`]
      );

      // Remove suspension from Redis so main API auth middleware allows login
      await redis.del(`suspended_user:${id}`);
      await redis.publish('admin:users', JSON.stringify({ action: 'unsuspended', userId: id }));

      results.push({ id, name: targetName, status: 'Active' });
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Error unsuspending users in bulk:', error);
    res.status(500).json({ error: 'Failed to unsuspend users in bulk' });
  }
};

exports.unsuspendUser = async (req, res) => {
  try {
    const { id } = req.params;
    const updateQuery = `UPDATE users SET is_suspended = false, suspended_until = NULL, moderation_flags = 0 WHERE user_id = $1 RETURNING full_name`;
    const result = await req.db.query(updateQuery, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetName = result.rows[0].full_name || 'user';
    const adminId = req.user.userId;

    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'USER_UNSUSPENDED', `Manually reinstated access for ${targetName}.`]
    );

    // Remove suspension from Redis
    await redis.del(`suspended_user:${id}`);
    await redis.publish('admin:users', JSON.stringify({ action: 'unsuspended', userId: id }));

    res.json({ success: true, message: 'User unsuspended and flags reset to 0' });
  } catch (error) {
    console.error('Error unsuspending user:', error);
    res.status(500).json({ error: 'Failed to unsuspend user' });
  }
};

exports.bulkWarnUsers = async (req, res) => {
  try {
    const { userIds, reason, message, isSevere } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'No user IDs provided' });
    }

    const adminId = req.user.userId;
    const points = isSevere ? 1 : 0;
    const results = [];

    for (const id of userIds) {
      // 1. Insert warning
      await req.db.query(
        'INSERT INTO user_warnings (user_id, reason, message, is_severe) VALUES ($1, $2, $3, $4)',
        [id, reason, message, isSevere]
      );

      await req.db.query(
        'INSERT INTO moderation_actions (target_type, target_id, action_type, reason, duration_days, performed_by) VALUES ($1, $2, $3, $4, $5, $6)',
        ['USER', id, 'WARNING', `${reason}. ${message}`, null, adminId]
      );

      // 2. Increment flags
      const updateResult = await req.db.query(
        'UPDATE users SET moderation_flags = COALESCE(moderation_flags, 0) + $2 WHERE user_id = $1 RETURNING moderation_flags, full_name, email',
        [id, points]
      );

      if (updateResult.rows.length === 0) {
        results.push({ id, status: 'Not Found' });
        continue;
      }

      const newFlagsCount = parseInt(updateResult.rows[0].moderation_flags);
      const targetName = updateResult.rows[0].full_name || 'user';
      const userEmail = updateResult.rows[0].email;
      let autoSuspended = false;

      // 3. Auto-suspension check
      if (newFlagsCount >= 7) {
        await req.db.query(
          'UPDATE users SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE user_id = $1',
          [id]
        );
        autoSuspended = true;
        await req.db.query(
          'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
          [adminId, 'USER_SUSPENDED', `Automatically suspended ${targetName} due to exceeding 7 moderation flags.`]
        );

        const actionRes = await req.db.query(
          'INSERT INTO moderation_actions (target_type, target_id, action_type, reason, duration_days, performed_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING action_id',
          ['USER', id, 'SUSPENSION', `Auto-suspension for exceeding 7 moderation flags. Your account has been automatically suspended due to repeated violations.`, 7, adminId]
        );

        const actionId = actionRes.rows[0].action_id;
        const appealToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        await req.db.query(
          'INSERT INTO appeal_tokens (action_id, token_hash, expires_at) VALUES ($1, $2, $3)',
          [actionId, appealToken, expiresAt]
        );

        try {
          if (userEmail) {
            await sendSuspensionAppealEmail(userEmail, targetName, appealToken, `Auto-suspension for exceeding 7 moderation flags.`);
          }
        } catch (e) {
          console.error('Failed to send suspension email:', e);
        }

        // Notify Main API to kill active sessions and blacklist token
        await redis.publish('admin:users', JSON.stringify({ action: 'suspended', userId: id }));
        await redis.setex(`suspended_user:${id}`, 7 * 24 * 60 * 60, 'true'); // 7 days TTL
      }

      // 4. Log warning
      const actionDesc = isSevere
        ? `Issued a SEVERE warning to ${targetName} for: ${reason}`
        : `Issued a warning to ${targetName} for: ${reason}`;
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'USER_WARNED', actionDesc]
      );

      // Notify the user via in-app notification database record and socket message
      const notificationText = isSevere 
        ? `Your account has been issued a severe warning for ${reason.toLowerCase()}.`
        : `Your account has been issued a warning for ${reason.toLowerCase()}.`;

      await req.db.query(`
        INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [id, null, 'user_warning', notificationText, id, JSON.stringify({ reason, message, isSevere, autoSuspended })]);

      socketService.notifyUser(id, "notification", {
        user_id: id,
        type: 'user_warning',
        text: notificationText,
        reference_id: id,
        created_at: new Date()
      });

      results.push({ id, name: targetName, moderation_flags: newFlagsCount, autoSuspended });
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Error warning users in bulk:', error);
    res.status(500).json({ error: 'Failed to warn users in bulk' });
  }
};

exports.bulkSuspendUsers = async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'No user IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of userIds) {
      const updateResult = await req.db.query(
        'UPDATE users SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1 WHERE user_id = $1 RETURNING full_name, email',
        [id]
      );

      if (updateResult.rows.length === 0) {
        results.push({ id, status: 'Not Found' });
        continue;
      }

      const targetName = updateResult.rows[0].full_name || 'user';
      const userEmail = updateResult.rows[0].email;
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'USER_SUSPENDED', `Manually suspended ${targetName} (Bulk Action).`]
      );

      const actionRes = await req.db.query(
        'INSERT INTO moderation_actions (target_type, target_id, action_type, reason, duration_days, performed_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING action_id',
        ['USER', id, 'SUSPENSION', `Bulk manual suspension by admin. Your account has been suspended for violating community guidelines.`, null, adminId]
      );

      const actionId = actionRes.rows[0].action_id;
      const appealToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      await req.db.query(
        'INSERT INTO appeal_tokens (action_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [actionId, appealToken, expiresAt]
      );

      try {
        if (userEmail) {
          await sendSuspensionAppealEmail(userEmail, targetName, appealToken, `Bulk manual suspension by admin.`);
        }
      } catch (e) {
        console.error('Failed to send suspension email:', e);
      }

      // Notify Main API to kill active sessions and blacklist token
      await redis.publish('admin:users', JSON.stringify({ action: 'suspended', userId: id }));
      await redis.setex(`suspended_user:${id}`, 365 * 24 * 60 * 60, 'true'); // 1 year TTL for bulk

      results.push({ id, name: targetName, status: 'Suspended' });
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Error suspending users in bulk:', error);
    res.status(500).json({ error: 'Failed to suspend users in bulk' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, role, location } = req.body;
    const adminId = req.user.userId;

    // Build dynamic query
    let queryArgs = [];
    let setStrings = [];
    let argCount = 1;

    if (name !== undefined) {
      setStrings.push(`full_name = $${argCount++}`);
      queryArgs.push(name);
    }
    if (phone !== undefined) {
      setStrings.push(`mobile_number = $${argCount++}`);
      queryArgs.push(phone);
    }
    if (role !== undefined) {
      setStrings.push(`user_type = $${argCount++}`);
      queryArgs.push(role);
    }
    if (location !== undefined) {
      setStrings.push(`location_formatted = $${argCount++}`);
      queryArgs.push(location);
    }

    if (setStrings.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    queryArgs.push(id);
    const updateQuery = `UPDATE users SET ${setStrings.join(', ')} WHERE user_id = $${argCount} RETURNING full_name, user_type`;

    const result = await req.db.query(updateQuery, queryArgs);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'USER_UPDATED', `Updated profile data for ${result.rows[0].full_name}`]
    );

    res.json({ success: true, message: 'User updated successfully' });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.userId;

    const result = await req.db.query(
      'UPDATE users SET is_deleted = true, deleted_at = NOW() WHERE user_id = $1 RETURNING full_name',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'USER_DELETED', `Soft deleted user ${result.rows[0].full_name}`]
    );

    await req.db.query(
      'INSERT INTO moderation_actions (target_type, target_id, action_type, reason, duration_days, performed_by) VALUES ($1, $2, $3, $4, $5, $6)',
      ['USER', id, 'BAN', `Manual soft deletion by admin. Your account has been deleted.`, null, adminId]
    );

    await redis.publish('admin:users', JSON.stringify({ action: 'deleted', userId: id }));
    await redis.setex(`deleted_user:${id}`, 30 * 24 * 60 * 60, 'true'); // 30 days TTL

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};

exports.restoreUser = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.userId;

    const result = await req.db.query(
      'UPDATE users SET is_deleted = false, deleted_at = NULL WHERE user_id = $1 RETURNING full_name',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'USER_RESTORED', `Restored deleted user ${result.rows[0].full_name}`]
    );

    await redis.del(`deleted_user:${id}`);

    res.json({ success: true, message: 'User restored successfully' });
  } catch (error) {
    console.error('Error restoring user:', error);
    res.status(500).json({ error: 'Failed to restore user' });
  }
};

exports.bulkDeleteUsers = async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'No user IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of userIds) {
      const updateResult = await req.db.query(
        'UPDATE users SET is_deleted = true, deleted_at = NOW() WHERE user_id = $1 RETURNING full_name',
        [id]
      );

      if (updateResult.rows.length === 0) {
        results.push({ id, status: 'Not Found' });
        continue;
      }

      const targetName = updateResult.rows[0].full_name || 'user';
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'USER_DELETED', `Soft deleted ${targetName} (Bulk Action).`]
      );

      await req.db.query(
        'INSERT INTO moderation_actions (target_type, target_id, action_type, reason, duration_days, performed_by) VALUES ($1, $2, $3, $4, $5, $6)',
        ['USER', id, 'BAN', `Bulk manual soft deletion by admin. Your account has been deleted.`, null, adminId]
      );

      await redis.publish('admin:users', JSON.stringify({ action: 'deleted', userId: id }));
      await redis.setex(`deleted_user:${id}`, 30 * 24 * 60 * 60, 'true'); // 30 days TTL

      results.push({ id, name: targetName, status: 'Deleted' });
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Error deleting users in bulk:', error);
    res.status(500).json({ error: 'Failed to delete users in bulk' });
  }
};

exports.getUserThoughts = async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT 
        c.comment_id AS id,
        c.content,
        c.created_at,
        p.post_id,
        p.content AS post_snippet
      FROM post_comments c
      JOIN posts p ON c.post_id = p.post_id
      WHERE c.author_id = $1
      ORDER BY c.created_at DESC
    `;
    const result = await req.db.query(query, [id]);

    const thoughts = result.rows.map(row => ({
      id: row.id,
      content: row.content,
      created_at: row.created_at,
      post_id: row.post_id,
      postSnippet: (row.post_snippet && row.post_snippet.length > 50)
        ? row.post_snippet.substring(0, 50) + '...'
        : row.post_snippet
    }));

    res.json(thoughts);
  } catch (error) {
    console.error('Error fetching user thoughts:', error);
    res.status(500).json({ error: 'Failed to fetch user thoughts' });
  }
};





exports.getVerificationQueue = async (req, res) => {
  try {
    const query = `
      SELECT 
        uv.verification_id as id,
        uv.user_id,
        uv.verification_type,
        uv.document_type,
        uv.front_image_url,
        uv.back_image_url,
        uv.is_verified,
        uv.status,
        uv.created_at,
        uv.updated_at,
        u.full_name as name,
        u.email,
        u.avatar_url,
        u.is_identity_verified
      FROM user_verifications uv
      JOIN users u ON uv.user_id = u.user_id
      ORDER BY uv.created_at DESC
    `;
    const result = await req.db.query(query);
    const verifications = result.rows.map(item => {
      let displayStatus = 'Under Review';
      let badgeColor = 'bg-amber-500';
      if (item.is_verified || item.status === 'VERIFIED') {
        displayStatus = 'Approved';
        badgeColor = 'bg-emerald-600';
      } else if (item.status === 'REJECTED') {
        displayStatus = 'Rejected';
        badgeColor = 'bg-rose-600';
      } else {
        displayStatus = 'Under Review';
        badgeColor = 'bg-amber-500';
      }

      return {
        ...item,
        status: displayStatus,
        statusBadgeColor: badgeColor,
      };
    });

    res.json(verifications);
  } catch (err) {
    console.error('Error in user getVerificationQueue:', err);
    res.status(500).json({ error: 'Failed to fetch user verification queue' });
  }
};

exports.reviewUserVerification = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, rejectionReason } = req.body;
    const adminId = req.user.userId;

    if (!['VERIFIED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid verification status. Must be VERIFIED or REJECTED' });
    }

    const { createAuditLog } = require('../../middlewares/auditLog.middleware');
    const client = await req.db.connect();
    try {
      await client.query('BEGIN');

      if (adminId) {
        await client.query(`
          INSERT INTO users (user_id, full_name, email, auth_provider, password_hash)
          VALUES ($1, 'Admin', 'admin@cocpit.ai', 'admin', 'N/A')
          ON CONFLICT (user_id) DO NOTHING
        `, [adminId]);
      }

      const verifRes = await client.query(
        `SELECT uv.*, u.full_name, u.email 
         FROM user_verifications uv 
         JOIN users u ON uv.user_id = u.user_id 
         WHERE uv.verification_id = $1`,
        [id]
      );

      if (verifRes.rows.length === 0) {
        throw new Error('Verification record not found');
      }

      const record = verifRes.rows[0];
      const targetUserId = record.user_id;
      const userName = record.full_name || 'User';

      const isVerified = status === 'VERIFIED';
      const fullNotes = rejectionReason ? `[Reason: ${rejectionReason}] ${notes || ''}` : notes;

      // 1. Update user_verifications
      await client.query(
        `UPDATE user_verifications 
         SET is_verified = $1, status = $2, updated_at = NOW() 
         WHERE verification_id = $3`,
        [isVerified, status, id]
      );

      // 2. Update users table
      await client.query(
        `UPDATE users 
         SET is_identity_verified = $1, updated_at = NOW() 
         WHERE user_id = $2`,
        [isVerified, targetUserId]
      );

      // 3. Log audit
      await client.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, `USER_VERIFICATION_${status}`, `Verification review for user "${userName}" (${targetUserId}): ${status}. Notes: ${fullNotes || 'None'}`]
      );
      await createAuditLog(adminId, `USER_VERIFICATION_${status}`, `Verification review for user "${userName}": ${status}. Notes: ${fullNotes || 'None'}`);

      // 4. Send notification
      const notificationText = isVerified
        ? 'Your identity verification has been approved! You are now verified on Cocpit.'
        : `Your identity verification was not approved. ${rejectionReason ? `Reason: ${rejectionReason}` : ''}`;

      await client.query(
        `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [targetUserId, adminId, 'user_identity_verification', notificationText, id, JSON.stringify({ verificationId: id, status, rejectionReason })]
      );

      if (socketService) {
        socketService.notifyUser(targetUserId, "notification", {
          user_id: targetUserId,
          type: 'user_identity_verification',
          text: notificationText,
          reference_id: id,
          created_at: new Date()
        });
      }

      await client.query('COMMIT');

      res.json({
        success: true,
        message: `User verification ${status.toLowerCase()} successfully`,
        status,
        userId: targetUserId
      });
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error in reviewUserVerification:', err);
    res.status(500).json({ error: 'Failed to complete user verification review', details: err.message });
  }
};
