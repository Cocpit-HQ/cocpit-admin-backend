const { pool } = require('../../config/db');
const redis = require('../../config/redis');
const socketService = require('../../services/socketBridge');

exports.getOrganizations = async (req, res) => {
  try {
    const { search = '', status = 'All', industry = 'All', page = 1, limit = 8 } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT org_id as id, name, legal_name, incorporation_date, verification_status, logo_url, slug, email, website, industry, location, is_suspended, created_at FROM organizations WHERE is_deleted = false';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR website ILIKE $${params.length} OR legal_name ILIKE $${params.length})`;
    }

    if (status !== 'All') {
      params.push(status === 'Suspended');
      query += ` AND is_suspended = $${params.length}`;
    }

    if (industry !== 'All') {
      params.push(industry);
      query += ` AND industry = $${params.length}`;
    }

    const countQuery = `SELECT COUNT(*) FROM (${query}) AS filtered_orgs`;
    const countRes = await req.db.query(countQuery, params);
    const totalCount = parseInt(countRes.rows[0].count, 10);

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const orgsRes = await req.db.query(query, params);
    const organizations = orgsRes.rows.map(org => ({
      id: org.id,
      name: org.name || 'Unnamed Org',
      legal_name: org.legal_name || org.name || '',
      incorporation_date: org.incorporation_date ? new Date(org.incorporation_date).toISOString().split('T')[0] : null,
      verification_status: org.verification_status || 'UNVERIFIED',
      logo_url: org.logo_url || null,
      slug: org.slug,
      email: org.email,
      website: org.website || 'N/A',
      industry: org.industry || 'Other',
      location: org.location || 'N/A',
      status: org.is_suspended ? 'Suspended' : 'Active',
      founded: org.created_at,
      initials: org.name ? org.name.substring(0, 2).toUpperCase() : 'NA'
    }));

    res.json({
      organizations,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      currentPage: parseInt(page, 10)
    });

  } catch (error) {
    console.error('Error fetching organizations:', error);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
};

exports.getOrganizationDetails = async (req, res) => {
  try {
    const { id } = req.params;
    
    // 1. Fetch organization core details
    const orgQuery = `
      SELECT o.org_id as id, o.name, o.legal_name, o.incorporation_date, o.slug, o.email, o.website, 
             o.industry, o.location, o.description, o.verification_status, o.review_notes, 
             o.moderation_flags, o.is_suspended, o.created_at, o.updated_at, o.parent_org_id, 
             o.size, o.slogan, o.logo_url, o.cover_url, o.entity_type, o.established_year,
             o.phone, o.phone_verified, o.email_verified, o.country, o.city, o.location_formatted,
             o.onboarding_completed, o.onboarding_step, o.created_by,
             u.full_name as owner_name, u.email as owner_email, u.avatar_url as owner_avatar
      FROM organizations o
      LEFT JOIN users u ON o.created_by = u.user_id
      WHERE o.org_id = $1 AND o.is_deleted = false
    `;

    // 2. Fetch documents
    const docsQuery = `
      SELECT document_id as id, document_url, document_name, document_type, uploaded_at
      FROM organization_documents
      WHERE org_id = $1
      ORDER BY uploaded_at DESC
    `;
    
    // 3. Fetch members
    const membersQuery = `
      SELECT om.user_id as id, u.full_name as name, u.email, u.avatar_url, om.status,
             COALESCE(oroles.name, om.role) as role, oroles.color
      FROM organization_members om
      JOIN users u ON om.user_id = u.user_id
      LEFT JOIN organization_roles oroles ON om.role_id = oroles.role_id
      WHERE om.org_id = $1
      ORDER BY om.joined_at DESC
    `;
    
    // 4. Fetch tech stack
    const techQuery = `
      SELECT stack_id as id, name, category, created_at
      FROM organization_tech_stack
      WHERE org_id = $1
    `;

    // 5. Fetch links
    const linksQuery = `
      SELECT link_id as id, platform, url, display_label
      FROM organization_links
      WHERE org_id = $1 AND is_deleted = false
    `;
    
    // 6. Fetch recent activity (audit logs)
    const activityQuery = `
      SELECT log_id as id, action as type, metadata,
             audit_logs.created_at as time, actor_id, u.full_name as author_name
      FROM audit_logs
      LEFT JOIN users u ON actor_id = u.user_id
      WHERE (entity_type = 'ORGANIZATION' OR entity_type = 'COMPANY') AND entity_id = $1
      ORDER BY audit_logs.created_at DESC
      LIMIT 20
    `;

    // 7. Fetch Overview KPI Counters
    const kpiQuery = `
      SELECT 
        (SELECT COUNT(*) FROM organization_members WHERE org_id = $1) as members_count,
        (SELECT COUNT(*) FROM jobs WHERE org_id = $1) as jobs_count,
        (SELECT COUNT(*) FROM posts WHERE author_org_id = $1 AND (is_deleted = false OR is_deleted IS NULL)) as posts_count,
        (SELECT COUNT(*) FROM reports WHERE target_type = 'COMPANY' AND target_id = $1 AND (status IS NULL OR status != 'RESOLVED')) as reports_count,
        (SELECT COUNT(*) FROM organization_warnings WHERE org_id = $1) as warnings_count
    `;

    const [orgRes, docsRes, membersRes, techRes, linksRes, activityRes, kpiRes] = await Promise.all([
      req.db.query(orgQuery, [id]),
      req.db.query(docsQuery, [id]),
      req.db.query(membersQuery, [id]),
      req.db.query(techQuery, [id]),
      req.db.query(linksQuery, [id]),
      req.db.query(activityQuery, [id]),
      req.db.query(kpiQuery, [id])
    ]);
    
    if (orgRes.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    const org = orgRes.rows[0];
    const kpi = kpiRes.rows[0] || {};

    // Calculate baseline risk alerts count
    let calculatedRiskAlerts = 0;
    if (!org.email_verified) calculatedRiskAlerts++;
    if (org.verification_status === 'UNVERIFIED' || org.verification_status === 'REJECTED') calculatedRiskAlerts++;
    if (parseInt(kpi.reports_count || 0, 10) > 0) calculatedRiskAlerts += parseInt(kpi.reports_count, 10);
    if (parseInt(kpi.warnings_count || 0, 10) > 0) calculatedRiskAlerts += parseInt(kpi.warnings_count, 10);

    // Format response to match frontend expectations
    const orgProfile = {
      org_id: org.id,
      name: org.name || 'Unnamed Org',
      legal_name: org.legal_name || org.name || '',
      incorporation_date: org.incorporation_date ? new Date(org.incorporation_date).toISOString().split('T')[0] : null,
      created_at: org.created_at,
      updated_at: org.updated_at,
      verification_status: org.verification_status || 'UNVERIFIED',
      logo_url: org.logo_url || null,
      cover_url: org.cover_url || null,
      slug: org.slug,
      email: org.email,
      phone: org.phone || null,
      phone_verified: Boolean(org.phone_verified),
      email_verified: Boolean(org.email_verified),
      website: org.website || 'N/A',
      industry: org.industry || 'Other',
      location: org.location || 'N/A',
      location_formatted: org.location_formatted || org.location || null,
      country: org.country || null,
      city: org.city || null,
      description: org.description || 'No description provided.',
      slogan: org.slogan || '',
      size: org.size || 'Unknown',
      entity_type: org.entity_type || 'COMPANY',
      established_year: org.established_year || (org.incorporation_date ? new Date(org.incorporation_date).getFullYear() : (org.created_at ? new Date(org.created_at).getFullYear() : null)),
      onboarding_completed: Boolean(org.onboarding_completed),
      onboarding_step: org.onboarding_step || 'COMPLETED',
      moderation_flags: parseInt(org.moderation_flags || 0, 10),
      status: org.is_suspended ? 'Suspended' : 'Active',
      review_notes: org.review_notes || '',
      owner: org.created_by ? {
        id: org.created_by,
        name: org.owner_name || 'Organization Owner',
        email: org.owner_email,
        avatar: org.owner_avatar
      } : null,
      overview: {
        totalMembers: parseInt(kpi.members_count || 0, 10),
        totalJobs: parseInt(kpi.jobs_count || 0, 10),
        totalPosts: parseInt(kpi.posts_count || 0, 10),
        openReports: parseInt(kpi.reports_count || 0, 10),
        riskAlertsCount: calculatedRiskAlerts
      },
      documents: docsRes.rows,
      members: membersRes.rows,
      techStack: techRes.rows,
      links: linksRes.rows,
      activity: activityRes.rows
    };
    
    res.json(orgProfile);
  } catch (error) {
    console.error('Error fetching organization details:', error);
    res.status(500).json({ error: 'Failed to fetch organization details' });
  }
};

// Module 1: Update permitted organization details
exports.updateOrganizationDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user?.userId;
    const {
      name,
      legal_name,
      incorporation_date,
      industry,
      size,
      website,
      email,
      phone,
      location,
      description,
      slogan
    } = req.body;

    // Check organization exists
    const checkRes = await req.db.query('SELECT name FROM organizations WHERE org_id = $1 AND is_deleted = false', [id]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const currentName = checkRes.rows[0].name;

    const updateQuery = `
      UPDATE organizations
      SET name = COALESCE($1, name),
          legal_name = COALESCE($2, legal_name),
          incorporation_date = COALESCE($3, incorporation_date),
          industry = COALESCE($4, industry),
          size = COALESCE($5, size),
          website = COALESCE($6, website),
          email = COALESCE($7, email),
          phone = COALESCE($8, phone),
          location = COALESCE($9, location),
          description = COALESCE($10, description),
          slogan = COALESCE($11, slogan),
          updated_at = NOW()
      WHERE org_id = $12 AND is_deleted = false
      RETURNING *
    `;

    const result = await req.db.query(updateQuery, [
      name ? name.trim() : null,
      legal_name ? legal_name.trim() : null,
      incorporation_date || null,
      industry || null,
      size || null,
      website || null,
      email ? email.trim() : null,
      phone || null,
      location || null,
      description || null,
      slogan || null,
      id
    ]);

    // Record in audit logs
    await req.db.query(
      `INSERT INTO audit_logs (entity_type, entity_id, actor_id, actor_role, action, metadata, created_at)
       VALUES ('ORGANIZATION', $1, $2, 'ADMIN', 'UPDATE_PROFILE', $3, NOW())`,
      [id, adminId, JSON.stringify({ changes: req.body, previous_name: currentName })]
    );

    if (adminId) {
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_PROFILE_UPDATED', `Admin updated profile for organization "${name || currentName}" (ID: ${id})`]
      );
    }

    res.json({ message: 'Organization updated successfully', organization: result.rows[0] });
  } catch (error) {
    console.error('Error updating organization:', error);
    res.status(500).json({ error: error.message || 'Failed to update organization' });
  }
};

// Module 2: Jobs and Hiring
exports.getOrganizationJobs = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, status = 'ALL', search = '' } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE j.org_id = $1';
    const params = [id];

    if (status !== 'ALL') {
      params.push(status);
      whereClause += ` AND j.status = $${params.length}`;
    }

    if (search.trim()) {
      params.push(`%${search.trim()}%`);
      whereClause += ` AND (j.title ILIKE $${params.length} OR j.location ILIKE $${params.length} OR j.job_type ILIKE $${params.length})`;
    }

    // Overall job counts for organization
    const statsQuery = `
      SELECT 
        COUNT(*) as total_jobs,
        COUNT(*) FILTER (WHERE status = 'ACTIVE') as active_jobs,
        COUNT(*) FILTER (WHERE status = 'DRAFT') as draft_jobs,
        COUNT(*) FILTER (WHERE status = 'CLOSED') as closed_jobs,
        COUNT(*) FILTER (WHERE status = 'EXPIRED') as expired_jobs,
        COUNT(*) FILTER (WHERE status = 'UNDER_REVIEW' OR moderation_status = 'UNDER_REVIEW') as review_jobs,
        (SELECT COUNT(*) FROM job_applications ja JOIN jobs j2 ON ja.job_id = j2.job_id WHERE j2.org_id = $1) as total_applications
      FROM jobs j
      WHERE j.org_id = $1
    `;

    // Paginated list
    const listQuery = `
      SELECT j.job_id, j.title, j.work_mode, j.job_type, j.company_type, j.location,
             j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.salary_visibility,
             j.experience_level, j.experience_min, j.experience_max, j.is_active, j.status,
             j.moderation_status, j.rejection_reason, j.description, j.about_company,
             j.created_at, j.updated_at, j.expires_at,
             u.full_name as recruiter_name, u.email as recruiter_email,
             (SELECT COUNT(*) FROM job_applications ja WHERE ja.job_id = j.job_id) as applications_count,
             (SELECT COUNT(*) FROM job_reports jr WHERE jr.job_id = j.job_id) as reports_count
      FROM jobs j
      LEFT JOIN users u ON j.recruiter_id = u.user_id
      ${whereClause}
      ORDER BY j.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countQuery = `SELECT COUNT(*) FROM jobs j ${whereClause}`;

    const [statsRes, countRes, listRes] = await Promise.all([
      req.db.query(statsQuery, [id]),
      req.db.query(countQuery, params),
      req.db.query(listQuery, [...params, limit, offset])
    ]);

    const total = parseInt(countRes.rows[0].count, 10);
    const stats = statsRes.rows[0] || {};

    // Analyze suspicious hiring patterns
    const jobsList = listRes.rows;
    const titleCounts = {};
    jobsList.forEach(job => {
      const normalizedTitle = (job.title || '').trim().toLowerCase();
      titleCounts[normalizedTitle] = (titleCounts[normalizedTitle] || 0) + 1;
    });

    const enrichedJobs = jobsList.map(job => {
      const normalizedTitle = (job.title || '').trim().toLowerCase();
      const hasDuplicateTitle = titleCounts[normalizedTitle] > 1;
      const hasSalaryAnomaly = (job.salary_min && job.salary_max && job.salary_min > job.salary_max) || (job.salary_max && job.salary_max > 500000);
      
      return {
        ...job,
        hiring_flags: {
          duplicate_title: hasDuplicateTitle,
          salary_anomaly: hasSalaryAnomaly,
          high_reports: parseInt(job.reports_count || 0, 10) > 0
        }
      };
    });

    res.json({
      jobs: enrichedJobs,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / limit) || 1,
      stats: {
        totalJobs: parseInt(stats.total_jobs || 0, 10),
        activeJobs: parseInt(stats.active_jobs || 0, 10),
        draftJobs: parseInt(stats.draft_jobs || 0, 10),
        closedJobs: parseInt(stats.closed_jobs || 0, 10),
        expiredJobs: parseInt(stats.expired_jobs || 0, 10),
        reviewJobs: parseInt(stats.review_jobs || 0, 10),
        totalApplications: parseInt(stats.total_applications || 0, 10)
      }
    });

  } catch (error) {
    console.error('Error fetching organization jobs:', error);
    res.status(500).json({ error: 'Failed to fetch organization jobs' });
  }
};

// Module 2: Moderate/Hide/Restore Job
exports.moderateOrganizationJob = async (req, res) => {
  try {
    const { id, jobId } = req.params;
    const { status, rejection_reason } = req.body;
    const adminId = req.user?.userId;

    if (!status) {
      return res.status(400).json({ error: 'Job status is required.' });
    }

    const updateQuery = `
      UPDATE jobs
      SET status = $1,
          moderation_status = $1,
          rejection_reason = COALESCE($2, rejection_reason),
          is_active = ($1 = 'ACTIVE'),
          updated_at = NOW()
      WHERE job_id = $3 AND org_id = $4
      RETURNING *
    `;

    const result = await req.db.query(updateQuery, [status, rejection_reason || null, jobId, id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found for this organization.' });
    }

    const updatedJob = result.rows[0];

    // Log in audit logs
    await req.db.query(
      `INSERT INTO audit_logs (entity_type, entity_id, actor_id, actor_role, action, metadata, created_at)
       VALUES ('ORGANIZATION', $1, $2, 'ADMIN', 'MODERATE_JOB', $3, NOW())`,
      [id, adminId, JSON.stringify({ jobId, new_status: status, reason: rejection_reason, job_title: updatedJob.title })]
    );

    if (adminId) {
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'JOB_MODERATION', `Admin updated job "${updatedJob.title}" status to ${status}. Reason: ${rejection_reason || 'N/A'}`]
      );
    }

    res.json({ message: `Job status updated to ${status}`, job: updatedJob });
  } catch (error) {
    console.error('Error moderating job:', error);
    res.status(500).json({ error: error.message || 'Failed to moderate job' });
  }
};

// Module 3: People and Company Team
exports.getOrganizationMembers = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, search = '', role = 'ALL' } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE om.org_id = $1';
    const params = [id];

    if (search.trim()) {
      params.push(`%${search.trim()}%`);
      whereClause += ` AND (u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
    }

    if (role !== 'ALL') {
      params.push(role);
      whereClause += ` AND (oroles.name = $${params.length} OR om.role = $${params.length})`;
    }

    // Members summary stats
    const statsQuery = `
      SELECT 
        COUNT(*) as total_members,
        COUNT(*) FILTER (WHERE om.status = 'ACTIVE') as active_members,
        COUNT(*) FILTER (WHERE om.status = 'SUSPENDED') as suspended_members,
        COUNT(*) FILTER (WHERE om.status = 'REMOVED') as removed_members,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(oroles.name, om.role, '')) LIKE '%owner%') as owners_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(oroles.name, om.role, '')) LIKE '%admin%') as admins_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(oroles.name, om.role, '')) LIKE '%recruiter%') as recruiters_count,
        (SELECT COUNT(*) FROM organization_invites WHERE org_id = $1 AND status = 'PENDING') as pending_invites
      FROM organization_members om
      LEFT JOIN organization_roles oroles ON om.role_id = oroles.role_id
      WHERE om.org_id = $1
    `;

    // Members paginated list
    const membersQuery = `
      SELECT om.member_id, om.user_id, om.status as membership_status, om.joined_at, om.updated_at,
             om.is_primary_display, om.is_role_visible,
             COALESCE(oroles.name, om.role, 'Member') as role_name,
             oroles.color as role_color,
             oroles.permissions as role_permissions,
             u.full_name, u.email, u.avatar_url, u.headline, u.is_suspended, u.is_identity_verified,
             u.last_active_at, u.created_at as user_created_at
      FROM organization_members om
      JOIN users u ON om.user_id = u.user_id
      LEFT JOIN organization_roles oroles ON om.role_id = oroles.role_id
      ${whereClause}
      ORDER BY om.joined_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countQuery = `
      SELECT COUNT(*)
      FROM organization_members om
      JOIN users u ON om.user_id = u.user_id
      LEFT JOIN organization_roles oroles ON om.role_id = oroles.role_id
      ${whereClause}
    `;

    // Fetch pending invitations
    const invitesQuery = `
      SELECT oi.invite_id, oi.email, oi.role, oi.status, oi.expires_at, oi.created_at,
             u.full_name as inviter_name
      FROM organization_invites oi
      LEFT JOIN users u ON oi.inviter_id = u.user_id
      WHERE oi.org_id = $1
      ORDER BY oi.created_at DESC
      LIMIT 20
    `;

    const [statsRes, countRes, membersRes, invitesRes] = await Promise.all([
      req.db.query(statsQuery, [id]),
      req.db.query(countQuery, params),
      req.db.query(membersQuery, [...params, limit, offset]),
      req.db.query(invitesQuery, [id])
    ]);

    const total = parseInt(countRes.rows[0].count, 10);
    const stats = statsRes.rows[0] || {};

    res.json({
      members: membersRes.rows,
      invitations: invitesRes.rows,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / limit) || 1,
      stats: {
        totalMembers: parseInt(stats.total_members || 0, 10),
        activeMembers: parseInt(stats.active_members || 0, 10),
        suspendedMembers: parseInt(stats.suspended_members || 0, 10),
        removedMembers: parseInt(stats.removed_members || 0, 10),
        ownersCount: parseInt(stats.owners_count || 0, 10),
        adminsCount: parseInt(stats.admins_count || 0, 10),
        recruitersCount: parseInt(stats.recruiters_count || 0, 10),
        pendingInvites: parseInt(stats.pending_invites || 0, 10)
      }
    });

  } catch (error) {
    console.error('Error fetching organization members:', error);
    res.status(500).json({ error: 'Failed to fetch organization members' });
  }
};

// Module 3: Revoke/Remove Member from Organization
exports.removeOrganizationMember = async (req, res) => {
  try {
    const { id, userId } = req.params;
    const adminId = req.user?.userId;
    const { reason } = req.body;

    // Check membership
    const checkRes = await req.db.query(
      'SELECT om.role, u.full_name FROM organization_members om JOIN users u ON om.user_id = u.user_id WHERE om.org_id = $1 AND om.user_id = $2',
      [id, userId]
    );

    if (checkRes.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found in this organization.' });
    }

    const memberName = checkRes.rows[0].full_name;
    const memberRole = checkRes.rows[0].role;

    // Remove from organization_members
    await req.db.query('DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2', [id, userId]);

    // Record audit log
    await req.db.query(
      `INSERT INTO audit_logs (entity_type, entity_id, actor_id, actor_role, action, metadata, created_at)
       VALUES ('ORGANIZATION', $1, $2, 'ADMIN', 'REMOVE_MEMBER', $3, NOW())`,
      [id, adminId, JSON.stringify({ removed_user_id: userId, removed_user_name: memberName, role: memberRole, reason })]
    );

    if (adminId) {
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_MEMBER_REMOVED', `Admin removed "${memberName}" (${memberRole}) from organization ID: ${id}. Reason: ${reason || 'N/A'}`]
      );
    }

    res.json({ message: `Successfully removed ${memberName} from the organization.` });
  } catch (error) {
    console.error('Error removing organization member:', error);
    res.status(500).json({ error: error.message || 'Failed to remove member' });
  }
};

// Module 4: Posts and Content
exports.getOrganizationPosts = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, search = '' } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE p.author_org_id = $1 AND (p.is_deleted = false OR p.is_deleted IS NULL)';
    const params = [id];

    if (search.trim()) {
      params.push(`%${search.trim()}%`);
      whereClause += ` AND (p.content ILIKE $${params.length} OR p.title ILIKE $${params.length})`;
    }

    // Stats
    const statsQuery = `
      SELECT 
        COUNT(*) as total_posts,
        COUNT(*) FILTER (WHERE p.is_removed = true OR p.status = 'HIDDEN') as hidden_posts,
        COUNT(*) FILTER (WHERE p.is_flagged = true) as flagged_posts,
        (SELECT COUNT(*) FROM post_likes pl JOIN posts p2 ON pl.post_id = p2.post_id WHERE p2.author_org_id = $1) as total_likes,
        (SELECT COUNT(*) FROM post_comments pc JOIN posts p2 ON pc.post_id = p2.post_id WHERE p2.author_org_id = $1) as total_comments,
        (SELECT COUNT(*) FROM post_shares ps JOIN posts p2 ON ps.post_id = p2.post_id WHERE p2.author_org_id = $1) as total_shares
      FROM posts p
      WHERE p.author_org_id = $1 AND (p.is_deleted = false OR p.is_deleted IS NULL)
    `;

    // Paginated list
    const listQuery = `
      SELECT p.post_id, p.author_id, p.title, p.content, p.visibility, p.post_type,
             p.created_at, p.updated_at, p.is_flagged, p.is_removed, p.removed_reason,
             p.is_broadcast, p.status,
             u.full_name as author_name, u.avatar_url as author_avatar,
             (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.post_id) as likes_count,
             (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id) as comments_count,
             (SELECT COUNT(*) FROM post_shares ps WHERE ps.post_id = p.post_id) as shares_count,
             (SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type)) FROM post_media pm WHERE pm.post_id = p.post_id) as media
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.user_id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countQuery = `SELECT COUNT(*) FROM posts p ${whereClause}`;

    const [statsRes, countRes, listRes] = await Promise.all([
      req.db.query(statsQuery, [id]),
      req.db.query(countQuery, params),
      req.db.query(listQuery, [...params, limit, offset])
    ]);

    const total = parseInt(countRes.rows[0].count, 10);
    const stats = statsRes.rows[0] || {};

    res.json({
      posts: listRes.rows,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / limit) || 1,
      stats: {
        totalPosts: parseInt(stats.total_posts || 0, 10),
        hiddenPosts: parseInt(stats.hidden_posts || 0, 10),
        flaggedPosts: parseInt(stats.flagged_posts || 0, 10),
        totalLikes: parseInt(stats.total_likes || 0, 10),
        totalComments: parseInt(stats.total_comments || 0, 10),
        totalShares: parseInt(stats.total_shares || 0, 10)
      }
    });

  } catch (error) {
    console.error('Error fetching organization posts:', error);
    res.status(500).json({ error: 'Failed to fetch organization posts' });
  }
};

// Module 4: Moderate Post (Hide / Remove / Restore)
exports.moderateOrganizationPost = async (req, res) => {
  try {
    const { id, postId } = req.params;
    const { action, reason } = req.body; // 'hide', 'restore', 'remove'
    const adminId = req.user?.userId;

    let updateQuery = '';
    let params = [];

    if (action === 'hide' || action === 'remove') {
      updateQuery = `
        UPDATE posts
        SET is_removed = true,
            status = 'HIDDEN',
            removed_reason = $1,
            removed_by = $2,
            updated_at = NOW()
        WHERE post_id = $3 AND author_org_id = $4
        RETURNING post_id, title
      `;
      params = [reason || 'Violates community guidelines', adminId, postId, id];
    } else if (action === 'restore') {
      updateQuery = `
        UPDATE posts
        SET is_removed = false,
            status = 'ACTIVE',
            removed_reason = NULL,
            removed_by = NULL,
            updated_at = NOW()
        WHERE post_id = $1 AND author_org_id = $2
        RETURNING post_id, title
      `;
      params = [postId, id];
    } else {
      return res.status(400).json({ error: 'Invalid moderation action. Must be hide, restore, or remove.' });
    }

    const result = await req.db.query(updateQuery, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found for this organization.' });
    }

    // Record audit log
    await req.db.query(
      `INSERT INTO audit_logs (entity_type, entity_id, actor_id, actor_role, action, metadata, created_at)
       VALUES ('ORGANIZATION', $1, $2, 'ADMIN', 'MODERATE_POST', $3, NOW())`,
      [id, adminId, JSON.stringify({ postId, action, reason })]
    );

    if (adminId) {
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'POST_MODERATION', `Admin performed ${action} on organization post ID: ${postId}. Reason: ${reason || 'N/A'}`]
      );
    }

    res.json({ message: `Post successfully ${action === 'restore' ? 'restored' : 'hidden'}`, post: result.rows[0] });
  } catch (error) {
    console.error('Error moderating post:', error);
    res.status(500).json({ error: error.message || 'Failed to moderate post' });
  }
};

// Module 4: Get comments for a specific post
exports.getOrganizationPostComments = async (req, res) => {
  try {
    const { postId } = req.params;
    const query = `
      SELECT pc.comment_id, pc.post_id, pc.content, pc.created_at, pc.is_deleted,
             u.full_name as author_name, u.avatar_url as author_avatar, u.email as author_email
      FROM post_comments pc
      LEFT JOIN users u ON pc.author_id = u.user_id
      WHERE pc.post_id = $1
      ORDER BY pc.created_at ASC
      LIMIT 100
    `;
    const result = await req.db.query(query, [postId]);
    res.json({ comments: result.rows });
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
};

// Module 5: Company Risk and Fraud Detection
exports.getOrganizationRisk = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Fetch organization identity signals
    const orgRes = await req.db.query(`
      SELECT o.org_id, o.name, o.legal_name, o.email, o.website, o.verification_status,
             o.phone, o.phone_verified, o.email_verified, o.created_at, o.size,
             (SELECT COUNT(*) FROM organization_documents WHERE org_id = o.org_id) as doc_count,
             (SELECT COUNT(*) FROM organization_warnings WHERE org_id = o.org_id) as warning_count
      FROM organizations o
      WHERE o.org_id = $1 AND o.is_deleted = false
    `, [id]);

    if (orgRes.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const org = orgRes.rows[0];

    // 2. Fetch jobs risk signals
    const jobsRes = await req.db.query(`
      SELECT COUNT(*) as total_jobs,
             COUNT(*) FILTER (WHERE salary_min > salary_max OR salary_max > 500000) as salary_anomalies,
             (SELECT COUNT(DISTINCT title) FROM jobs WHERE org_id = $1) as unique_titles
      FROM jobs
      WHERE org_id = $1
    `, [id]);
    const jobsData = jobsRes.rows[0] || {};

    // 3. Fetch user reports filed against this company
    const reportsRes = await req.db.query(`
      SELECT r.id, r.created_at, r.status, r.severity, r.custom_reason, r.reason,
             rr.label as category_label, u.full_name as reporter_name
      FROM reports r
      LEFT JOIN report_reasons rr ON r.reason_id = rr.id
      LEFT JOIN users u ON r.reporter_id = u.user_id
      WHERE r.target_type = 'COMPANY' AND r.target_id = $1
      ORDER BY r.created_at DESC
      LIMIT 20
    `, [id]);

    // 4. Fetch past investigation notes from audit logs
    const notesRes = await req.db.query(`
      SELECT al.log_id as id, al.metadata, al.created_at, u.full_name as admin_name
      FROM audit_logs al
      LEFT JOIN users u ON al.actor_id = u.user_id
      WHERE al.entity_id = $1 AND al.action = 'RISK_INVESTIGATION_NOTE'
      ORDER BY al.created_at DESC
      LIMIT 20
    `, [id]);

    // Compute heuristic risk indicators
    const indicators = [];
    const freeEmailProviders = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'mail.com', 'aol.com'];
    const emailDomain = (org.email || '').split('@')[1]?.toLowerCase();

    // Indicator: Disposable/Free Email for Enterprise
    if (emailDomain && freeEmailProviders.includes(emailDomain)) {
      indicators.push({
        id: 'FREE_EMAIL_DOMAIN',
        name: 'Public Domain Email Registered',
        severity: 'MEDIUM',
        reason: 'Organization registered using a consumer email provider instead of corporate business domain.',
        evidence: `Registered email: ${org.email}`,
        status: 'Needs Review',
        detectionDate: org.created_at
      });
    }

    // Indicator: Unverified Identity with Zero Documents
    if (org.verification_status === 'UNVERIFIED' && parseInt(org.doc_count || 0, 10) === 0) {
      indicators.push({
        id: 'UNVERIFIED_NO_DOCUMENTS',
        name: 'Unverified Entity & Missing Credentials',
        severity: 'LOW',
        reason: 'No registration certificate or business license uploaded for review.',
        evidence: `Documents on file: ${org.doc_count}`,
        status: 'Needs Review',
        detectionDate: org.created_at
      });
    }

    // Indicator: Website / Name Inconsistency
    if (org.website && org.name) {
      const cleanWebsite = org.website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].split('.')[0].toLowerCase();
      const cleanName = org.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      if (cleanWebsite.length > 4 && cleanName.length > 4 && !cleanName.includes(cleanWebsite) && !cleanWebsite.includes(cleanName)) {
        indicators.push({
          id: 'DOMAIN_NAME_MISMATCH',
          name: 'Domain & Brand Name Discrepancy',
          severity: 'LOW',
          reason: 'Company brand name differs significantly from the domain name in the corporate website link.',
          evidence: `Name: "${org.name}" vs Website: "${org.website}"`,
          status: 'Needs Review',
          detectionDate: org.created_at
        });
      }
    }

    // Indicator: High Duplicate Job Titles
    const totalJobs = parseInt(jobsData.total_jobs || 0, 10);
    const uniqueTitles = parseInt(jobsData.unique_titles || 0, 10);
    if (totalJobs > 5 && uniqueTitles < totalJobs * 0.5) {
      indicators.push({
        id: 'DUPLICATE_JOB_SPAM',
        name: 'Excessive Duplicate Job Postings',
        severity: 'HIGH',
        reason: 'High proportion of duplicate job titles detected, indicating possible recruiter spam.',
        evidence: `${totalJobs} total jobs posted across only ${uniqueTitles} unique titles.`,
        status: 'Under Investigation',
        detectionDate: new Date()
      });
    }

    // Indicator: Salary Anomalies
    if (parseInt(jobsData.salary_anomalies || 0, 10) > 0) {
      indicators.push({
        id: 'SALARY_ANOMALY',
        name: 'Unrealistic or Inverted Salary Range',
        severity: 'MEDIUM',
        reason: 'Job postings with min salary greater than max salary or values exceeding normal boundaries.',
        evidence: `${jobsData.salary_anomalies} anomalous job listing(s) identified.`,
        status: 'Needs Review',
        detectionDate: new Date()
      });
    }

    // Indicator: Active User Reports
    const openReportsCount = reportsRes.rows.filter(r => !r.status || r.status !== 'RESOLVED').length;
    if (openReportsCount > 0) {
      indicators.push({
        id: 'ACTIVE_USER_REPORTS',
        name: 'Pending User Abuse Reports',
        severity: openReportsCount >= 3 ? 'HIGH' : 'MEDIUM',
        reason: 'Community members have submitted abuse or scam reports against this organization.',
        evidence: `${openReportsCount} unresolved report(s) on file.`,
        status: 'High Risk',
        detectionDate: new Date()
      });
    }

    // Indicator: Previous Warning Strikes
    const warningsCount = parseInt(org.warning_count || 0, 10);
    if (warningsCount > 0) {
      indicators.push({
        id: 'HISTORICAL_WARNINGS',
        name: 'Previous Disciplinary Warnings',
        severity: warningsCount >= 3 ? 'CRITICAL' : 'MEDIUM',
        reason: 'Organization has accumulated prior moderation warnings and policy strikes.',
        evidence: `${warningsCount} official warning(s) issued.`,
        status: warningsCount >= 3 ? 'High Risk' : 'Needs Review',
        detectionDate: org.created_at
      });
    }

    // Determine overall risk level
    let overallRiskLevel = 'NORMAL';
    if (indicators.some(i => i.severity === 'CRITICAL' || i.severity === 'HIGH')) {
      overallRiskLevel = 'HIGH_RISK';
    } else if (indicators.some(i => i.severity === 'MEDIUM')) {
      overallRiskLevel = 'NEEDS_REVIEW';
    }

    res.json({
      riskLevel: overallRiskLevel,
      indicators,
      reports: reportsRes.rows,
      investigationNotes: notesRes.rows.map(n => ({
        id: n.id,
        note: n.metadata?.note || '',
        decision: n.metadata?.decision || 'Review ongoing',
        riskStatus: n.metadata?.riskStatus || 'Needs Review',
        adminName: n.admin_name || 'Admin',
        createdAt: n.created_at
      }))
    });

  } catch (error) {
    console.error('Error fetching organization risk:', error);
    res.status(500).json({ error: 'Failed to fetch risk assessment' });
  }
};

// Module 5: Add Investigation Note
exports.addOrganizationInvestigationNote = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user?.userId;
    const { note, decision = 'Review Completed', riskStatus = 'Normal' } = req.body;

    if (!note || !note.trim()) {
      return res.status(400).json({ error: 'Investigation note is required.' });
    }

    const metadata = {
      note: note.trim(),
      decision,
      riskStatus,
      recordedAt: new Date()
    };

    await req.db.query(
      `INSERT INTO audit_logs (entity_type, entity_id, actor_id, actor_role, action, metadata, created_at)
       VALUES ('ORGANIZATION', $1, $2, 'ADMIN', 'RISK_INVESTIGATION_NOTE', $3, NOW())`,
      [id, adminId, JSON.stringify(metadata)]
    );

    if (adminId) {
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_INVESTIGATION_NOTE', `Admin recorded investigation note for org ID: ${id}. Decision: ${decision}`]
      );
    }

    res.json({ message: 'Investigation note recorded successfully', note: metadata });
  } catch (error) {
    console.error('Error recording investigation note:', error);
    res.status(500).json({ error: error.message || 'Failed to record note' });
  }
};

// Module 6: Company History and Chronological Timeline
exports.getOrganizationTimeline = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20, category = 'ALL', search = '' } = req.query;
    const offset = (page - 1) * limit;

    let categoryFilter = '';
    const params = [id];

    if (category !== 'ALL') {
      params.push(category);
      categoryFilter = `AND category = $${params.length}`;
    }

    let searchFilter = '';
    if (search.trim()) {
      params.push(`%${search.trim()}%`);
      searchFilter = `AND (title ILIKE $${params.length} OR actor_name ILIKE $${params.length})`;
    }

    const query = `
      WITH unified_timeline AS (
        -- Profile Edits
        SELECT log_id::text as id, 'PROFILE' as category, action as title, metadata::jsonb as metadata, created_at, actor_id
        FROM audit_logs 
        WHERE (entity_type = 'ORGANIZATION' OR entity_type = 'COMPANY') AND entity_id = $1

        UNION ALL

        -- Admin Actions
        SELECT log_id::text as id, 'MODERATION' as category, action_type as title, jsonb_build_object('description', description) as metadata, created_at, user_id as actor_id
        FROM admin_audit_logs
        WHERE description ILIKE '%' || $1 || '%'

        UNION ALL

        -- Verification Events
        SELECT verification_id::text as id, 'VERIFICATION' as category, 
               CASE WHEN is_verified = true THEN 'Verification Approved' ELSE 'Verification Submitted' END as title, 
               jsonb_build_object('is_verified', is_verified, 'legal_name', legal_name, 'notes', review_notes) as metadata, 
               created_at, reviewed_by as actor_id
        FROM organization_verifications
        WHERE org_id = $1

        UNION ALL

        -- Warnings
        SELECT warning_id::text as id, 'MODERATION' as category, 'Warning: ' || reason as title, jsonb_build_object('message', message, 'is_severe', is_severe) as metadata, created_at, issued_by as actor_id
        FROM organization_warnings
        WHERE org_id = $1

        UNION ALL

        -- Jobs
        SELECT job_id::text as id, 'JOBS' as category, 'Job Created: ' || title as title, jsonb_build_object('title', title, 'status', status, 'location', location) as metadata, created_at, recruiter_id as actor_id
        FROM jobs
        WHERE org_id = $1

        UNION ALL

        -- Posts
        SELECT post_id::text as id, 'POSTS' as category, 'Post Broadcast: ' || COALESCE(title, 'Feed Post') as title, jsonb_build_object('content', substring(content, 1, 80)) as metadata, created_at, author_id as actor_id
        FROM posts
        WHERE author_org_id = $1

        UNION ALL

        -- Team Members
        SELECT member_id::text as id, 'MEMBERS' as category, 'Member Joined: ' || COALESCE(role, 'Member') as title, jsonb_build_object('status', status, 'role', role) as metadata, joined_at as created_at, user_id as actor_id
        FROM organization_members
        WHERE org_id = $1
      )
      SELECT ut.*, u.full_name as actor_name, u.avatar_url as actor_avatar
      FROM unified_timeline ut
      LEFT JOIN users u ON ut.actor_id = u.user_id
      WHERE 1=1 ${categoryFilter} ${searchFilter}
      ORDER BY ut.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countQuery = `
      WITH unified_timeline AS (
        SELECT log_id::text as id, 'PROFILE' as category, action as title, actor_id FROM audit_logs WHERE (entity_type = 'ORGANIZATION' OR entity_type = 'COMPANY') AND entity_id = $1
        UNION ALL
        SELECT log_id::text as id, 'MODERATION' as category, action_type as title, user_id as actor_id FROM admin_audit_logs WHERE description ILIKE '%' || $1 || '%'
        UNION ALL
        SELECT verification_id::text as id, 'VERIFICATION' as category, 'Verification' as title, reviewed_by as actor_id FROM organization_verifications WHERE org_id = $1
        UNION ALL
        SELECT warning_id::text as id, 'MODERATION' as category, 'Warning' as title, issued_by as actor_id FROM organization_warnings WHERE org_id = $1
        UNION ALL
        SELECT job_id::text as id, 'JOBS' as category, 'Job' as title, recruiter_id as actor_id FROM jobs WHERE org_id = $1
        UNION ALL
        SELECT post_id::text as id, 'POSTS' as category, 'Post' as title, author_id as actor_id FROM posts WHERE author_org_id = $1
        UNION ALL
        SELECT member_id::text as id, 'MEMBERS' as category, 'Member' as title, user_id as actor_id FROM organization_members WHERE org_id = $1
      )
      SELECT COUNT(*)
      FROM unified_timeline ut
      LEFT JOIN users u ON ut.actor_id = u.user_id
      WHERE 1=1 ${categoryFilter} ${searchFilter}
    `;

    const [eventsRes, countRes] = await Promise.all([
      req.db.query(query, [...params, limit, offset]),
      req.db.query(countQuery, params)
    ]);

    const total = parseInt(countRes.rows[0].count, 10);

    res.json({
      events: eventsRes.rows,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / limit) || 1
    });

  } catch (error) {
    console.error('Error fetching organization timeline:', error);
    res.status(500).json({ error: 'Failed to fetch activity timeline' });
  }
};

// Module 7: Company Security
exports.getOrganizationSecurity = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Fetch active member sessions
    const sessionsQuery = `
      SELECT rt.session_id, rt.user_id, u.full_name as member_name, u.email as member_email,
             rt.ip_address::text, rt.user_agent, rt.created_at as login_time, rt.expires_at, rt.revoked,
             ds.device_id, ds.platform, ds.last_active_at, ds.is_active
      FROM refresh_tokens rt
      JOIN users u ON rt.user_id = u.user_id
      LEFT JOIN device_sessions ds ON rt.session_id = ds.session_id
      WHERE rt.user_id IN (SELECT user_id FROM organization_members WHERE org_id = $1)
         OR rt.user_id = (SELECT created_by FROM organizations WHERE org_id = $1)
      ORDER BY COALESCE(ds.last_active_at, rt.created_at) DESC
      LIMIT 50
    `;

    // 2. Fetch Owner & Admin Security Posture
    const securityPostureQuery = `
      SELECT u.user_id, u.full_name, u.email, u.is_suspended, u.is_identity_verified,
             u.mobile_number, u.last_active_at, om.role
      FROM users u
      JOIN organization_members om ON u.user_id = om.user_id
      WHERE om.org_id = $1 AND (LOWER(om.role) LIKE '%owner%' OR LOWER(om.role) LIKE '%admin%')
    `;

    // 3. Fetch security incident history from audit logs
    const incidentsQuery = `
      SELECT log_id as id, action as incident_type, metadata, created_at
      FROM audit_logs
      WHERE entity_id = $1 AND action IN ('REVOKE_SESSION', 'REVOKE_ALL_SESSIONS', 'SECURITY_ALERT', 'COMPROMISED_ACCOUNT_FLAG')
      ORDER BY created_at DESC
      LIMIT 20
    `;

    const [sessionsRes, postureRes, incidentsRes] = await Promise.all([
      req.db.query(sessionsQuery, [id]),
      req.db.query(securityPostureQuery, [id]),
      req.db.query(incidentsQuery, [id])
    ]);

    res.json({
      sessions: sessionsRes.rows.map(s => ({
        sessionId: s.session_id,
        userId: s.user_id,
        memberName: s.member_name,
        memberEmail: s.member_email,
        platform: s.platform || 'web',
        userAgent: s.user_agent,
        ipAddress: s.ip_address || 'Unknown',
        loginTime: s.login_time,
        lastActiveAt: s.last_active_at || s.login_time,
        isActive: s.is_active !== false && !s.revoked
      })),
      memberSecurity: postureRes.rows,
      incidents: incidentsRes.rows
    });

  } catch (error) {
    console.error('Error fetching organization security:', error);
    res.status(500).json({ error: 'Failed to fetch security details' });
  }
};

// Module 7: Revoke Session
exports.revokeOrganizationSession = async (req, res) => {
  try {
    const { id } = req.params;
    const { sessionId, revokeAll = false } = req.body;
    const adminId = req.user?.userId;

    if (!revokeAll && !sessionId) {
      return res.status(400).json({ error: 'Session ID is required unless revoking all sessions.' });
    }

    if (revokeAll) {
      // Revoke all sessions for organization members
      await req.db.query(`
        UPDATE refresh_tokens
        SET revoked = true
        WHERE user_id IN (SELECT user_id FROM organization_members WHERE org_id = $1)
           OR user_id = (SELECT created_by FROM organizations WHERE org_id = $1)
      `, [id]);

      await req.db.query(`
        UPDATE device_sessions
        SET is_active = false
        WHERE user_id IN (SELECT user_id FROM organization_members WHERE org_id = $1)
           OR user_id = (SELECT created_by FROM organizations WHERE org_id = $1)
      `, [id]);

      await req.db.query(
        `INSERT INTO audit_logs (entity_type, entity_id, actor_id, actor_role, action, metadata, created_at)
         VALUES ('ORGANIZATION', $1, $2, 'ADMIN', 'REVOKE_ALL_SESSIONS', $3, NOW())`,
        [id, adminId, JSON.stringify({ reason: 'Emergency admin session termination' })]
      );

      if (adminId) {
        await req.db.query(
          'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
          [adminId, 'ORG_SESSIONS_REVOKED', `Admin revoked ALL active sessions for organization ID: ${id}`]
        );
      }

      return res.json({ message: 'All active sessions for organization members have been revoked.' });
    }

    // Revoke single session
    await req.db.query('UPDATE refresh_tokens SET revoked = true WHERE session_id = $1', [sessionId]);
    await req.db.query('UPDATE device_sessions SET is_active = false WHERE session_id = $1', [sessionId]);

    await req.db.query(
      `INSERT INTO audit_logs (entity_type, entity_id, actor_id, actor_role, action, metadata, created_at)
       VALUES ('ORGANIZATION', $1, $2, 'ADMIN', 'REVOKE_SESSION', $3, NOW())`,
      [id, adminId, JSON.stringify({ sessionId })]
    );

    if (adminId) {
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_SESSION_REVOKED', `Admin revoked session ${sessionId} for organization ID: ${id}`]
      );
    }

    res.json({ message: 'Session revoked successfully.' });
  } catch (error) {
    console.error('Error revoking session:', error);
    res.status(500).json({ error: error.message || 'Failed to revoke session' });
  }
};

exports.warnOrganization = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, message, isSevere } = req.body;
    
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'Warning reason is required.' });
    }
    
    let points = 0;
    if (isSevere) {
      points = 1;
    }
    
    await req.db.query(
      'INSERT INTO organization_warnings (org_id, reason, message, is_severe, issued_by) VALUES ($1, $2, $3, $4, $5)',
      [id, reason, message, isSevere, req.user?.userId || null]
    );

    const updateQuery = `
      UPDATE organizations 
      SET moderation_flags = COALESCE(moderation_flags, 0) + $2 
      WHERE org_id = $1 
      RETURNING moderation_flags, name, created_by
    `;
    const result = await req.db.query(updateQuery, [id, points]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    const newFlagsCount = parseInt(result.rows[0].moderation_flags);
    const targetName = result.rows[0].name || 'organization';
    const orgCreatorId = result.rows[0].created_by;
    const adminId = req.user.userId;
    let autoSuspended = false;
    
    if (newFlagsCount >= 7) {
      await req.db.query(
        'UPDATE organizations SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE org_id = $1',
        [id]
      );
      autoSuspended = true;
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_SUSPENDED', `Automatically suspended ${targetName} due to exceeding 7 moderation flags.`]
      );
    }
    
    if (orgCreatorId) {
      const notificationText = isSevere 
        ? `Your organization "${targetName}" has received a severe warning. Reason: ${reason}. Message: ${message || 'No additional details'}`
        : `Your organization "${targetName}" has received a warning. Reason: ${reason}. Message: ${message || 'No additional details'}`;
      
      await req.db.query(`
        INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [orgCreatorId, adminId, 'organization_warning', notificationText, id, JSON.stringify({ orgId: id, reason, message, isSevere, autoSuspended })]);
      
      await req.db.query(`
        INSERT INTO notifications (recipient_org_id, sender_id, type, text, reference_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [id, adminId, 'organization_warning', notificationText, id, JSON.stringify({ orgId: id, reason, message, isSevere, autoSuspended })]);
      
      socketService.notifyUser(orgCreatorId, "notification", {
        user_id: orgCreatorId,
        type: 'organization_warning',
        text: notificationText,
        reference_id: id,
        created_at: new Date()
      });
    }

    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'ORG_WARNING_SENT', `Sent a ${isSevere ? 'severe ' : ''}warning to ${targetName}. Reason: ${reason}`]
    );

    res.json({ message: 'Warning sent successfully', autoSuspended });
  } catch (error) {
    console.error('Error warning organization:', error);
    res.status(500).json({ error: 'Failed to warn organization' });
  }
};

exports.suspendOrganization = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.userId;
    
    await req.db.query(
      'UPDATE organizations SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE org_id = $1',
      [id]
    );
    
    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'ORG_SUSPENDED', `Manually suspended organization with ID: ${id}`]
    );
    
    res.json({ message: 'Organization suspended successfully.' });
  } catch (error) {
    console.error('Error suspending organization:', error);
    res.status(500).json({ error: 'Failed to suspend organization' });
  }
};

exports.unsuspendOrganization = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.userId;
    
    await req.db.query(
      'UPDATE organizations SET is_suspended = false, moderation_flags = 0 WHERE org_id = $1',
      [id]
    );
    
    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'ORG_UNSUSPENDED', `Manually unsuspended organization with ID: ${id}`]
    );
    
    res.json({ message: 'Organization unsuspended successfully.' });
  } catch (error) {
    console.error('Error unsuspending organization:', error);
    res.status(500).json({ error: 'Failed to unsuspend organization' });
  }
};

exports.getOrganizationIndustries = async (req, res) => {
  try {
    const result = await req.db.query('SELECT DISTINCT industry FROM organizations WHERE industry IS NOT NULL AND is_deleted = false ORDER BY industry ASC');
    res.json(result.rows.map(r => r.industry));
  } catch (error) {
    console.error('Error fetching industries:', error);
    res.status(500).json({ error: 'Failed to fetch industries' });
  }
};

exports.getVerificationQueue = async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '', status } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT o.org_id as id, o.name, o.legal_name, o.incorporation_date, o.slug, o.email, o.website, 
             o.industry, o.location, o.location_formatted, o.size, o.description,
             o.verification_status, o.review_notes, o.created_at, o.logo_url,
             u.full_name as owner_name, u.email as owner_email,
             (
               SELECT COALESCE(json_agg(json_build_object(
                 'id', d.document_id,
                 'document_name', d.document_name,
                 'document_url', d.document_url,
                 'document_type', d.document_type,
                 'uploaded_at', d.uploaded_at
               ) ORDER BY d.uploaded_at DESC), '[]'::json)
               FROM organization_documents d
               WHERE d.org_id = o.org_id
             ) as documents,
             (SELECT COUNT(*) FROM organization_documents WHERE org_id = o.org_id) as document_count
      FROM organizations o
      LEFT JOIN users u ON o.created_by = u.user_id
      WHERE o.is_deleted = false
    `;
    const params = [];

    if (status && status !== 'All') {
      params.push(status);
      query += ` AND o.verification_status = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (o.name ILIKE $${params.length} OR o.email ILIKE $${params.length} OR o.legal_name ILIKE $${params.length})`;
    }

    const countQuery = `SELECT COUNT(*) FROM (${query}) AS queue_count`;
    const countRes = await req.db.query(countQuery, params);
    const totalCount = parseInt(countRes.rows[0].count, 10);

    query += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await req.db.query(query, params);
    
    res.json({
      verifications: result.rows,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      currentPage: parseInt(page, 10)
    });
  } catch (error) {
    console.error('Error fetching verification queue:', error);
    res.status(500).json({ error: 'Failed to fetch verification queue' });
  }
};

exports.reviewDocument = async (req, res) => {
  try {
    const { documentId } = req.params;
    const { status, rejectionReason } = req.body;
    const adminId = req.user.userId;
    
    if (!['VERIFIED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid document review status' });
    }
    
    res.json({ message: `Document marked as ${status.toLowerCase()}` });
  } catch (error) {
    console.error('Error reviewing document:', error);
    res.status(500).json({ error: 'Failed to review document' });
  }
};

exports.reviewOrganizationVerification = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, rejectionReason } = req.body;
    const adminId = req.user.userId;
    
    if (!['VERIFIED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid verification status' });
    }
    
    if (status === 'REJECTED' && (!rejectionReason || !rejectionReason.trim())) {
      return res.status(400).json({ error: 'Rejection reason is required when rejecting verification' });
    }
    
    const client = await req.db.connect();
    try {
      await client.query('BEGIN');
      
      const fullNotes = rejectionReason 
        ? `${notes ? notes + ' | ' : ''}Rejection Reason: ${rejectionReason}`
        : notes;
      
      const updateResult = await client.query(
        'UPDATE organizations SET verification_status = $1, review_notes = $2, updated_at = NOW() WHERE org_id = $3 RETURNING name, created_by',
        [status, fullNotes, id]
      );
      
      if (updateResult.rows.length === 0) {
        throw new Error('Organization not found');
      }
      
      const orgName = updateResult.rows[0].name;
      const orgCreatorId = updateResult.rows[0].created_by;
      
      await client.query(
        `UPDATE organization_verifications 
         SET is_verified = $1, reviewed_by = $2, review_notes = $3
         WHERE org_id = $4`,
        [status === 'VERIFIED', adminId, fullNotes, id]
      );
      
      if (status === 'REJECTED') {
        await client.query(
          `UPDATE jobs SET status = 'PAUSED', is_active = false WHERE org_id = $1 AND status = 'ACTIVE'`,
          [id]
        );
      }
      
      await client.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, `ORG_VERIFICATION_${status}`, `Final review for organization "${orgName}": ${status}. Notes: ${fullNotes || 'None'}`]
      );
      
      if (orgCreatorId) {
        const notificationText = status === 'VERIFIED' 
          ? `Your organization "${orgName}" has been verified.`
          : `Your organization "${orgName}" verification was rejected. Reason: ${rejectionReason || 'See notes'}`;
          
        await client.query(`
          INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [orgCreatorId, adminId, 'organization_verification', notificationText, id, JSON.stringify({ orgId: id, status, rejectionReason })]);
        
        await client.query(`
          INSERT INTO notifications (recipient_org_id, sender_id, type, text, reference_id, metadata)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [id, adminId, 'organization_verification', notificationText, id, JSON.stringify({ orgId: id, status, rejectionReason })]);
        
        socketService.notifyUser(orgCreatorId, "notification", {
          user_id: orgCreatorId,
          type: 'organization_verification',
          text: notificationText,
          reference_id: id,
          created_at: new Date()
        });
      }
      
      await client.query('COMMIT');
      
      try {
        await redis.publish('admin:organizations', JSON.stringify({ action: 'verification_updated', orgId: id, status }));
      } catch (rErr) {
        console.warn('Redis pub/sub notification skipped:', rErr.message);
      }
      
      res.json({ message: `Organization verification ${status.toLowerCase()} successfully` });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      res.status(400).json({ error: e.message });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error in reviewOrganizationVerification:', err);
    res.status(500).json({ error: 'Failed to complete organization verification review', details: err.message });
  }
};

exports.bulkWarnOrganizations = async (req, res) => {
  try {
    const { orgIds, reason, message, isSevere } = req.body;
    if (!Array.isArray(orgIds) || orgIds.length === 0) {
      return res.status(400).json({ error: 'No organization IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of orgIds) {
      const updateResult = await req.db.query(
        'UPDATE organizations SET moderation_flags = COALESCE(moderation_flags, 0) + $1 WHERE org_id = $2 RETURNING name, created_by, moderation_flags',
        [isSevere ? 1 : 0, id]
      );
      if (updateResult.rows.length === 0) continue;

      const { name: targetName, created_by: orgCreatorId, moderation_flags: newFlagsCount } = updateResult.rows[0];
      let autoSuspended = false;

      if (newFlagsCount >= 7) {
        await req.db.query('UPDATE organizations SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE org_id = $1', [id]);
        autoSuspended = true;
        await req.db.query('INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)', [adminId, 'ORG_SUSPENDED', `Automatically suspended ${targetName} due to flags.`]);
      }

      await req.db.query('INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)', [adminId, 'ORG_WARNING_SENT', `Sent warning to ${targetName}. Reason: ${reason} (Bulk)`]);
      results.push({ id, name: targetName, moderation_flags: newFlagsCount, autoSuspended });
    }
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error warning organizations in bulk:', error);
    res.status(500).json({ error: 'Failed to warn organizations in bulk' });
  }
};

exports.bulkSuspendOrganizations = async (req, res) => {
  try {
    const { orgIds } = req.body;
    if (!Array.isArray(orgIds) || orgIds.length === 0) {
      return res.status(400).json({ error: 'No organization IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of orgIds) {
      const updateResult = await req.db.query(
        'UPDATE organizations SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE org_id = $1 RETURNING name',
        [id]
      );
      if (updateResult.rows.length === 0) continue;

      const targetName = updateResult.rows[0].name;
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_SUSPENDED', `Manually suspended ${targetName} (Bulk)`]
      );
      results.push({ id, name: targetName, status: 'Suspended' });
    }
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error suspending organizations in bulk:', error);
    res.status(500).json({ error: 'Failed to suspend organizations in bulk' });
  }
};

exports.bulkDeleteOrganizations = async (req, res) => {
  try {
    const { orgIds } = req.body;
    if (!Array.isArray(orgIds) || orgIds.length === 0) {
      return res.status(400).json({ error: 'No organization IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of orgIds) {
      const updateResult = await req.db.query(
        'UPDATE organizations SET is_deleted = true WHERE org_id = $1 RETURNING name',
        [id]
      );
      if (updateResult.rows.length === 0) continue;

      const targetName = updateResult.rows[0].name;
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_DELETED', `Soft deleted ${targetName} (Bulk)`]
      );
      results.push({ id, name: targetName, status: 'Deleted' });
    }
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error deleting organizations in bulk:', error);
    res.status(500).json({ error: 'Failed to delete organizations in bulk' });
  }
};

exports.bulkUnsuspendOrganizations = async (req, res) => {
  try {
    const { orgIds } = req.body;
    if (!Array.isArray(orgIds) || orgIds.length === 0) {
      return res.status(400).json({ error: 'No organization IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of orgIds) {
      const updateResult = await req.db.query(
        'UPDATE organizations SET is_suspended = false, moderation_flags = 0 WHERE org_id = $1 RETURNING name',
        [id]
      );
      if (updateResult.rows.length === 0) continue;

      const targetName = updateResult.rows[0].name;
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_UNSUSPENDED', `Manually unsuspended ${targetName} (Bulk)`]
      );
      results.push({ id, name: targetName, status: 'Active' });
    }
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error unsuspending organizations in bulk:', error);
    res.status(500).json({ error: 'Failed to unsuspend organizations in bulk' });
  }
};

exports.submitOrganizationVerification = async (req, res) => {
  try {
    const { id } = req.params;
    const { legal_name, incorporation_date, document_url, document_name, document_type = 'CERTIFICATE_OF_INCORPORATION' } = req.body;
    const adminId = req.user?.userId;

    if (!legal_name || !legal_name.trim()) {
      return res.status(400).json({ error: 'Organization legal full name is required' });
    }
    if (!incorporation_date) {
      return res.status(400).json({ error: 'Incorporation date is required' });
    }

    const client = await req.db.connect();
    try {
      await client.query('BEGIN');

      // 1. Update organizations table
      const updateOrgQuery = `
        UPDATE organizations
        SET legal_name = $1,
            incorporation_date = $2,
            verification_status = 'UNDER_REVIEW',
            updated_at = NOW()
        WHERE org_id = $3 AND is_deleted = false
        RETURNING name, slug, logo_url, created_by
      `;
      const orgRes = await client.query(updateOrgQuery, [legal_name.trim(), incorporation_date, id]);
      if (orgRes.rows.length === 0) {
        throw new Error('Organization not found');
      }
      const org = orgRes.rows[0];

      // 2. Insert into organization_documents if document provided
      let docRecord = null;
      if (document_url) {
        const docName = document_name || `${legal_name.trim()}_Verification_Document`;
        const insertDocQuery = `
          INSERT INTO organization_documents (org_id, document_url, document_name, document_type, uploaded_at)
          VALUES ($1, $2, $3, $4, NOW())
          RETURNING document_id, document_url, document_name
        `;
        const docRes = await client.query(insertDocQuery, [id, document_url, docName, document_type]);
        docRecord = docRes.rows[0];
      }

      // 3. Insert or update organization_verifications tracking
      const insertVerifQuery = `
        INSERT INTO organization_verifications (
          org_id, user_id, verification_type, legal_name, incorporation_date, document_urls, document_type, is_verified, created_at
        ) VALUES (
          $1, $2, 'DOCUMENT', $3, $4, $5, $6, false, NOW()
        )
        RETURNING verification_id
      `;
      await client.query(insertVerifQuery, [
        id,
        org.created_by || adminId,
        legal_name.trim(),
        incorporation_date,
        document_url || null,
        document_type
      ]);

      // 4. Log audit action
      if (adminId) {
        await client.query(
          'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
          [adminId, 'ORG_VERIFICATION_SUBMITTED', `Submitted verification credentials for organization "${org.name}": Legal Name: ${legal_name}, Inc. Date: ${incorporation_date}`]
        );
      }

      await client.query('COMMIT');

      // Publish Redis event for real-time awareness
      try {
        await redis.publish('admin:organizations', JSON.stringify({
          action: 'verification_submitted',
          orgId: id,
          legal_name: legal_name.trim(),
          status: 'UNDER_REVIEW'
        }));
      } catch (rErr) {
        console.warn('Redis pub/sub notification skipped:', rErr.message);
      }

      res.json({
        message: 'Organization verification submitted successfully',
        org: {
          id,
          name: org.name,
          legal_name: legal_name.trim(),
          incorporation_date,
          verification_status: 'UNDER_REVIEW',
          document: docRecord
        }
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error submitting organization verification:', error);
    res.status(500).json({ error: error.message || 'Failed to submit organization verification' });
  }
};
