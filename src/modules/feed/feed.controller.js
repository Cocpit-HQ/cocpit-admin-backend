const { pool } = require('../../config/db');
const redis = require('../../config/redis');

// GET /api/admin/feed/metrics
exports.getFeedMetrics = async (req, res) => {
  try {
    // Parse date range (default to last 30 days)
    const end = req.query.endDate ? new Date(req.query.endDate) : new Date();
    const start = req.query.startDate ? new Date(req.query.startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    // 1. Total Daily Activity Volume (posts created today in UTC)
    const dailyVolumeRes = await req.db.query(
      "SELECT COUNT(*) FROM posts WHERE created_at >= NOW() - INTERVAL '24 hours'"
    );
    const dailyActivityVolume = parseInt(dailyVolumeRes.rows[0].count, 10);

    // 2. Engagement Rate calculation:
    // (Total Likes + Total Comments + Total Shares in period) / (Active Users in period)
    const activeUsersRes = await req.db.query(
      "SELECT COUNT(DISTINCT user_id) FROM user_activity_log WHERE created_at >= $1 AND created_at <= $2",
      [start.toISOString(), end.toISOString()]
    );
    const activeUsersCount = parseInt(activeUsersRes.rows[0].count, 10) || 1; // avoid divide by zero

    const likesCountRes = await req.db.query(
      "SELECT COUNT(*) FROM post_likes WHERE created_at >= $1 AND created_at <= $2",
      [start.toISOString(), end.toISOString()]
    );
    const commentsCountRes = await req.db.query(
      "SELECT COUNT(*) FROM post_comments WHERE created_at >= $1 AND created_at <= $2",
      [start.toISOString(), end.toISOString()]
    );
    const sharesCountRes = await req.db.query(
      "SELECT COUNT(*) FROM post_shares WHERE created_at >= $1 AND created_at <= $2",
      [start.toISOString(), end.toISOString()]
    );

    const totalLikes = parseInt(likesCountRes.rows[0].count, 10);
    const totalComments = parseInt(commentsCountRes.rows[0].count, 10);
    const totalShares = parseInt(sharesCountRes.rows[0].count, 10);
    const totalInteractions = totalLikes + totalComments + totalShares;

    const engagementRate = activeUsersCount > 0
      ? parseFloat(((totalInteractions / activeUsersCount) * 100).toFixed(1))
      : 0;

    // 3. Avg Engagement per Post (interactions / total posts in period)
    const postsCountRes = await req.db.query(
      "SELECT COUNT(*) FROM posts WHERE created_at >= $1 AND created_at <= $2",
      [start.toISOString(), end.toISOString()]
    );
    const totalPosts = parseInt(postsCountRes.rows[0].count, 10) || 1;
    const avgEngagementPerPost = parseFloat((totalInteractions / totalPosts).toFixed(1));

    res.json({
      engagementRate,
      dailyActivityVolume,
      avgEngagementPerPost
    });
  } catch (error) {
    console.error('Error fetching feed metrics:', error);
    res.status(500).json({ error: 'Failed to fetch feed metrics' });
  }
};

// GET /api/admin/feed/posts
exports.getFeedPosts = async (req, res) => {
  try {
    const { role, location, sort, page = 1, limit = 10, unlistedOnly, deletedOnly, userId, likedOnly, commentedOnly } = req.query;
    const offset = (page - 1) * limit;

    let whereClauses = [];
    if (!userId) {
      // whereClauses.push("p.created_at >= NOW() - INTERVAL '30 days'");
    }
    if (deletedOnly === 'true') {
      whereClauses.push("(COALESCE(p.is_active, true) = false OR COALESCE(p.is_deleted, false) = true OR COALESCE(p.is_removed, false) = true)");
    } else {
      whereClauses.push("(COALESCE(p.is_active, true) = true AND COALESCE(p.is_deleted, false) = false AND COALESCE(p.is_removed, false) = false)");
      if (unlistedOnly === 'true') {
        whereClauses.push("p.is_unlisted = true");
      } else if (unlistedOnly === 'false') {
        whereClauses.push("p.is_unlisted = false");
      }
    }
    if (likedOnly === 'true') {
      whereClauses.push("EXISTS (SELECT 1 FROM post_likes pl WHERE pl.post_id = p.post_id)");
    }
    if (commentedOnly === 'true') {
      whereClauses.push("EXISTS (SELECT 1 FROM post_comments pc WHERE pc.post_id = p.post_id)");
    }

    let queryParams = [];
    let paramIndex = 1;

    if (userId) {
      whereClauses.push(`p.author_id = $${paramIndex}`);
      queryParams.push(userId);
      paramIndex++;
    }

    // Filter by Role
    if (role && role !== 'All Roles') {
      let jobTitleFilter = '';
      if (role === 'Software Engineers') {
        jobTitleFilter = '%engineer%';
      } else if (role === 'Designers') {
        jobTitleFilter = '%design%';
      } else if (role === 'Founders / Executives') {
        jobTitleFilter = '%founder%';
      }
      if (jobTitleFilter) {
        whereClauses.push(`u.job_title ILIKE $${paramIndex}`);
        queryParams.push(jobTitleFilter);
        paramIndex++;
      }
    }

    // Filter by Location
    if (location && location !== 'All Locations') {
      if (location === 'Remote / Hybrid') {
        whereClauses.push(`(u.location ILIKE '%remote%' OR u.location ILIKE '%hybrid%')`);
      } else {
        whereClauses.push(`u.location ILIKE $${paramIndex}`);
        queryParams.push(`%${location}%`);
        paramIndex++;
      }
    }

    // If sorting by Highly Reported, only return posts that have actually been reported
    if (sort === 'Highly Reported') {
      whereClauses.push("EXISTS (SELECT 1 FROM reports rep WHERE rep.target_type = 'post' AND rep.target_id = p.post_id)");
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const isMostLiked = sort && (sort === 'Most Liked' || sort.toLowerCase().includes('like'));
    const isMostCommented = sort && (sort === 'Most Commented' || sort.toLowerCase().includes('comment'));
    const isMostTagged = sort && (sort === 'Most Tagged' || sort.toLowerCase().includes('tag'));
    const isHighlyReported = sort && (sort === 'Highly Reported' || sort.toLowerCase().includes('report'));

    // Sort order
    let orderSql = 'ORDER BY p.created_at DESC, p.post_id DESC';
    if (deletedOnly === 'true') {
      orderSql = 'ORDER BY COALESCE(p.updated_at, p.created_at) DESC, p.post_id DESC';
    } else if (isMostLiked) {
      orderSql = 'ORDER BY likes DESC, p.created_at DESC, p.post_id DESC';
    } else if (isMostCommented) {
      orderSql = 'ORDER BY comments DESC, p.created_at DESC, p.post_id DESC';
    } else if (isMostTagged) {
      orderSql = 'ORDER BY tags DESC, p.created_at DESC, p.post_id DESC';
    } else if (isHighlyReported) {
      orderSql = 'ORDER BY reports DESC, p.created_at DESC, p.post_id DESC';
    }

    const postsQuery = `
      SELECT 
        p.post_id AS id,
        p.content,
        p.created_at,
        p.is_unlisted AS "isUnlisted",
        COALESCE(p.is_active, true) AS "isActive",
        COALESCE(p.is_deleted, false) AS "isDeleted",
        COALESCE(p.is_removed, false) AS "isRemoved",
        p.removed_reason AS "removedReason",
        u.full_name AS author,
        u.job_title AS title,
        u.company_name AS company,
        u.location,
        u.avatar_url AS avatar,
        COALESCE(pm.first_media_url, NULL) AS "mediaUrl",
        COALESCE(pm.first_media_type, NULL) AS "mediaType",
        COALESCE(pm.media_list, '[]'::json) AS "mediaList",
        COALESCE(l.likes_count, 0) AS likes,
        COALESCE(c.comments_count, 0) AS comments,
        COALESCE(s.shares_count, 0) AS shares,
        COALESCE(tg.tags_count, 0) AS tags,
        COALESCE(r.reports_count, 0) AS reports,
        u.moderation_flags,
        pa.reason AS "appealReason",
        pa.status AS "appealStatus"
      FROM posts p
      JOIN users u ON p.author_id = u.user_id
      LEFT JOIN (
        SELECT 
          post_id,
          json_agg(json_build_object('url', url, 'media_type', media_type, 'width', width, 'height', height)) AS media_list,
          (ARRAY_AGG(url))[1] AS first_media_url,
          (ARRAY_AGG(media_type))[1] AS first_media_type
        FROM post_media
        GROUP BY post_id
      ) pm ON p.post_id = pm.post_id
      LEFT JOIN post_appeals pa ON p.post_id = pa.post_id AND pa.status = 'pending'
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS likes_count FROM post_likes GROUP BY post_id
      ) l ON p.post_id = l.post_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS comments_count FROM post_comments GROUP BY post_id
      ) c ON p.post_id = c.post_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS shares_count FROM post_shares GROUP BY post_id
      ) s ON p.post_id = s.post_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS tags_count 
        FROM (
          SELECT post_id FROM post_hashtags
          UNION ALL
          SELECT post_id FROM post_tags
        ) all_tags
        GROUP BY post_id
      ) tg ON p.post_id = tg.post_id
      LEFT JOIN (
        SELECT target_id, COUNT(*) AS reports_count FROM reports WHERE target_type = 'post' GROUP BY target_id
      ) r ON p.post_id = r.target_id
      ${whereSql}
      ${orderSql}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const countQuery = `
      SELECT COUNT(*) 
      FROM posts p
      JOIN users u ON p.author_id = u.user_id
      ${whereSql}
    `;

    const countRes = await req.db.query(countQuery, queryParams);
    const totalPosts = parseInt(countRes.rows[0].count, 10);

    const postsRes = await req.db.query(postsQuery, [...queryParams, limit, offset]);

    // Filter out posts that contain raw code, stack traces, console errors, or code frame lines
    const filteredRows = postsRes.rows.filter(row => {
      const content = row.content || '';
      if (
        content.includes('## Error Type') ||
        content.includes('AxiosError') ||
        content.includes('at async') ||
        /\d+\s*\|/.test(content)
      ) {
        return false;
      }
      return true;
    });

    // Format response to match frontend expectations
    const posts = filteredRows.map(row => ({
      id: row.id,
      author: row.author,
      title: row.title || '',
      company: row.company || '',
      location: row.location || 'Unknown',
      avatar: row.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(row.author)}&background=e0e7ff&color=3730a3`,
      content: row.content,
      mediaUrl: row.mediaUrl,
      mediaType: row.mediaType,
      mediaList: row.mediaList || [],
      created_at: row.created_at,
      metrics: {
        likes: parseInt(row.likes, 10),
        comments: parseInt(row.comments, 10),
        shares: parseInt(row.shares, 10),
        tags: parseInt(row.tags || 0, 10),
        saves: 0,
        clicks: 0
      },
      aiFlag: row.moderation_flags > 2 ? { type: 'safety', message: `High Risk: Author has ${row.moderation_flags} moderation flags.` } : null,
      status: (!row.isActive || row.isDeleted || row.isRemoved) ? 'deleted' : (row.isUnlisted ? 'unlisted' : 'active'),
      isUnlisted: !!row.isUnlisted,
      isDeleted: !row.isActive || !!row.isDeleted || !!row.isRemoved,
      removedReason: row.removedReason || null,
      appeal: row.appealStatus === 'pending' ? {
        reason: row.appealReason,
        status: row.appealStatus
      } : null
    }));

    res.json({
      posts,
      totalPosts,
      currentPage: parseInt(page, 10),
      totalPages: Math.ceil(totalPosts / limit)
    });
  } catch (error) {
    console.error('Error fetching feed posts:', error);
    res.status(500).json({ error: 'Failed to fetch feed posts' });
  }
};

// DELETE /api/admin/feed/posts/:id
exports.deleteFeedPost = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'Post Moderation Takedown', message = 'Your post has been unlisted for violating community guidelines.' } = req.body;

    // Verify post exists
    const checkRes = await req.db.query('SELECT post_id, author_id FROM posts WHERE post_id = $1', [id]);
    if (checkRes.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const post = checkRes.rows[0];

    // Soft takedown: Toggle is_unlisted to true and make it private
    await req.db.query("UPDATE posts SET is_unlisted = true, visibility = 'private' WHERE post_id = $1", [id]);

    // Purge from global feed pools
    if (redis.status === 'ready') {
      await redis.zrem('feed:explore:pool', id);
      await redis.zrem('feed:trending:global', id);
    }

    // Send a warning notification to the author
    await req.db.query(
      'INSERT INTO user_warnings (user_id, reason, message, is_severe) VALUES ($1, $2, $3, false)',
      [post.author_id, reason, message]
    );

    // Audit log
    await req.db.query(
      `INSERT INTO admin_audit_logs (user_id, action_type, description) 
       VALUES ($1, 'UNLIST_POST', $2)`,
      [req.user.sub || null, `Unlisted post ${id} by user ${post.author_id} for: ${reason}`]
    );

    res.json({ success: true, message: 'Post successfully unlisted and warning sent' });
  } catch (error) {
    console.error('Error unlisting feed post:', error);
    res.status(500).json({ error: 'Failed to unlist feed post' });
  }
};

// POST /api/admin/feed/posts/:id/restore
exports.restoreFeedPost = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify post exists
    const checkRes = await req.db.query('SELECT post_id, author_id FROM posts WHERE post_id = $1', [id]);
    if (checkRes.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const post = checkRes.rows[0];

    // Restore: Toggle is_active to true, is_unlisted to false, is_deleted to false, is_removed to false and make it public again
    await req.db.query("UPDATE posts SET is_active = true, is_unlisted = false, is_deleted = false, is_removed = false, visibility = 'public' WHERE post_id = $1", [id]);

    // Resolve pending appeals as approved
    await req.db.query("UPDATE post_appeals SET status = 'approved', reviewed_at = NOW() WHERE post_id = $1 AND status = 'pending'", [id]);

    // Notify Main API to emit Socket.io notification
    try {
      await fetch('http://localhost:5000/internal/v1/appeals/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_API_SECRET
        },
        body: JSON.stringify({
          userId: post.author_id,
          postId: id,
          status: 'approved',
          reason: 'Admin approved your appeal'
        })
      });
    } catch (notifyErr) {
      console.error('Failed to notify Main API for appeal approval:', notifyErr);
    }

    // Audit log
    await req.db.query(
      `INSERT INTO admin_audit_logs (user_id, action_type, description) 
       VALUES ($1, 'RESTORE_POST', $2)`,
      [req.user.sub || null, `Restored post ${id} by user ${post.author_id}`]
    );

    res.json({ success: true, message: 'Post successfully restored to public status' });
  } catch (error) {
    console.error('Error restoring feed post:', error);
    res.status(500).json({ error: 'Failed to restore feed post' });
  }
};

// POST /api/admin/feed/posts/:id/reject-appeal
exports.rejectFeedPostAppeal = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify post exists
    const checkRes = await req.db.query('SELECT post_id, author_id FROM posts WHERE post_id = $1', [id]);
    if (checkRes.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const post = checkRes.rows[0];

    // Resolve pending appeals as rejected
    await req.db.query("UPDATE post_appeals SET status = 'rejected', reviewed_at = NOW() WHERE post_id = $1 AND status = 'pending'", [id]);

    // Notify Main API to emit Socket.io notification
    try {
      await fetch('http://localhost:5000/internal/v1/appeals/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_API_SECRET
        },
        body: JSON.stringify({
          userId: post.author_id,
          postId: id,
          status: 'rejected',
          reason: 'Admin rejected your appeal'
        })
      });
    } catch (notifyErr) {
      console.error('Failed to notify Main API for appeal rejection:', notifyErr);
    }

    // Audit log
    await req.db.query(
      `INSERT INTO admin_audit_logs (user_id, action_type, description) 
       VALUES ($1, 'REJECT_APPEAL', $2)`,
      [req.user.sub || null, `Rejected appeal for post ${id} by user ${post.author_id}`]
    );

    res.json({ success: true, message: 'Appeal successfully rejected' });
  } catch (error) {
    console.error('Error rejecting feed post appeal:', error);
    res.status(500).json({ error: 'Failed to reject feed post appeal' });
  }
};

// GET /api/admin/feed/hashtags
exports.getTrendingHashtags = async (req, res) => {
  try {
    const result = await req.db.query(
      `SELECT 
         h.hashtag_id AS id, 
         h.tag, 
         h.usage_count,
         CASE 
           WHEN COALESCE(ph.recent_count, 0) > 0 THEN CONCAT('+', GREATEST(ROUND(ph.recent_count / 24.0), 1), '/hr')
           ELSE CONCAT('+', GREATEST(ROUND(h.usage_count / 10.0), 1), '/hr')
         END AS velocity
       FROM hashtags h
       LEFT JOIN (
         SELECT hashtag_id, COUNT(*) AS recent_count 
         FROM post_hashtags 
         WHERE created_at >= NOW() - INTERVAL '24 hours' 
         GROUP BY hashtag_id
       ) ph ON h.hashtag_id = ph.hashtag_id
       ORDER BY h.usage_count DESC 
       LIMIT 6`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trending hashtags:', error);
    res.status(500).json({ error: 'Failed to fetch trending hashtags' });
  }
};

// GET /api/admin/feed/leaderboard
exports.getFeedLeaderboard = async (req, res) => {
  try {
    const query = `
      SELECT 
        p.post_id AS id,
        CASE WHEN LENGTH(p.content) > 60 THEN CONCAT(SUBSTRING(p.content, 1, 60), '...') ELSE p.content END AS title,
        u.full_name AS author,
        COALESCE(l.likes_count, 0) AS likes,
        COALESCE(c.comments_count, 0) AS comments,
        COALESCE(s.shares_count, 0) AS shares
      FROM posts p
      JOIN users u ON p.author_id = u.user_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS likes_count FROM post_likes GROUP BY post_id
      ) l ON p.post_id = l.post_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS comments_count FROM post_comments GROUP BY post_id
      ) c ON p.post_id = c.post_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS shares_count FROM post_shares GROUP BY post_id
      ) s ON p.post_id = s.post_id
      ORDER BY (COALESCE(l.likes_count, 0) + (COALESCE(c.comments_count, 0) * 2) + (COALESCE(s.shares_count, 0) * 3)) DESC
      LIMIT 5
    `;
    const result = await req.db.query(query);
    res.json(result.rows.map(row => ({
      id: row.id,
      title: row.title || 'Untitled Post',
      author: row.author,
      likes: parseInt(row.likes, 10),
      comments: parseInt(row.comments, 10),
      shares: parseInt(row.shares, 10)
    })));
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
};

// GET /api/admin/feed/posts/:id/comments
exports.getPostComments = async (req, res) => {
  try {
    const { id } = req.params;
    const query = `
      SELECT 
        c.comment_id AS id,
        c.content,
        c.created_at,
        c.parent_id,
        u.full_name AS author,
        u.avatar_url AS avatar,
        u.job_title AS title,
        u.company_name AS company
      FROM post_comments c
      JOIN users u ON c.author_id = u.user_id
      WHERE c.post_id = $1
      ORDER BY c.created_at ASC
    `;
    const result = await req.db.query(query, [id]);
    res.json(result.rows.map(row => ({
      id: row.id,
      content: row.content,
      created_at: row.created_at,
      parent_id: row.parent_id,
      author: row.author,
      title: row.title || 'Professional',
      company: row.company || 'Platform User',
      avatar: row.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(row.author)}&background=e0e7ff&color=3730a3`
    })));
  } catch (error) {
    console.error('Error fetching post comments:', error);
    res.status(500).json({ error: 'Failed to fetch post comments' });
  }
};

// POST /api/admin/feed/posts/:id/comments
exports.createPostComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { content, parent_id } = req.body;
    const userId = req.user.sub || req.user.id; // Admin user ID from token

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const insertQuery = `
      INSERT INTO post_comments (post_id, author_id, content, parent_id)
      VALUES ($1, $2, $3, $4)
      RETURNING comment_id AS id, content, created_at, parent_id
    `;
    const result = await req.db.query(insertQuery, [id, userId, content, parent_id || null]);

    // Fetch the admin user details to return a complete comment object
    const userQuery = `SELECT full_name, avatar_url, job_title, company_name FROM users WHERE user_id = $1`;
    const userResult = await req.db.query(userQuery, [userId]);
    const u = userResult.rows[0] || {};

    const newComment = {
      id: result.rows[0].id,
      content: result.rows[0].content,
      created_at: result.rows[0].created_at,
      parent_id: result.rows[0].parent_id,
      author: u.full_name || 'Admin',
      avatar: u.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.full_name || 'Admin')}&background=e0e7ff&color=3730a3`,
      title: u.job_title || 'Admin',
      company: u.company_name || 'COCPIT'
    };

    res.status(201).json(newComment);
  } catch (error) {
    console.error('Error creating post comment:', error);
    res.status(500).json({ error: 'Failed to create post comment' });
  }
};

exports.getPostById = async (req, res) => {
  try {
    const { id } = req.params;
    const query = `
      SELECT 
        p.post_id AS id,
        p.content,
        p.created_at,
        u.full_name AS author,
        u.email AS author_email,
        u.avatar_url AS author_avatar,
        (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.post_id) AS likes_count,
        (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.post_id) AS comments_count,
        (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'POST' AND r.target_id = p.post_id) AS reports_count
      FROM posts p
      JOIN users u ON p.author_id = u.user_id
      WHERE p.post_id = $1
    `;
    const result = await req.db.query(query, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching post:', error);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
};

// GET /api/admin/feed/channels
exports.getAllChannels = async (req, res) => {
  try {
    const query = `
      SELECT 
        c.community_id AS id,
        c.name,
        c.description,
        c.banner_url,
        c.created_at,
        c.org_id,
        u.full_name AS created_by_name,
        (SELECT COUNT(*) FROM posts WHERE author_org_id = c.org_id AND post_type = 'article') AS article_count
      FROM communities c
      LEFT JOIN users u ON c.created_by = u.user_id
      WHERE c.is_active = TRUE
      ORDER BY c.created_at DESC
    `;
    const result = await req.db.query(query);
    res.json({ channels: result.rows });
  } catch (error) {
    console.error('Error fetching channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
};

// GET /api/admin/feed/channels/:id/articles
exports.getChannelArticles = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if the channel (community) exists
    const channelQuery = `SELECT org_id FROM communities WHERE community_id = $1 AND is_active = TRUE`;
    const channelResult = await req.db.query(channelQuery, [id]);
    if (channelResult.rows.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const orgId = channelResult.rows[0].org_id;

    // Fetch articles (posts by the organization)
    const articlesQuery = `
      SELECT 
        p.post_id AS id,
        p.title,
        p.content,
        p.created_at AS "publishedat",
        COALESCE(pm.url, NULL) AS "mediaUrl",
        (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.post_id) AS comments_count
      FROM posts p
      LEFT JOIN post_media pm ON p.post_id = pm.post_id
      WHERE p.author_org_id = $1 AND p.post_type = 'article'
      ORDER BY p.created_at DESC
    `;
    const articlesResult = await req.db.query(articlesQuery, [orgId]);

    // Post process to extract title from content if title is missing
    const articles = articlesResult.rows.map(row => {
      let title = row.title;
      if (!title) {
        const lines = row.content ? row.content.split('\n') : [];
        title = lines.length > 0 ? lines[0].substring(0, 50) : 'Untitled Article';
      }
      return {
        id: row.id,
        title,
        content: row.content,
        publishedAt: row.publishedat,
        mediaUrl: row.mediaUrl,
        commentsCount: parseInt(row.comments_count, 10)
      };
    });

    res.json({ articles });
  } catch (error) {
    console.error('Error fetching channel articles:', error);
    res.status(500).json({ error: 'Failed to fetch channel articles' });
  }
};

// GET /api/admin/feed/thoughts
exports.getAllThoughts = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const countRes = await req.db.query('SELECT COUNT(*) FROM post_comments');
    const totalThoughts = parseInt(countRes.rows[0].count, 10);

    const query = `
      SELECT 
        c.comment_id AS id,
        c.content,
        c.created_at,
        c.author_id,
        p.post_id,
        u.full_name AS author,
        u.avatar_url AS avatar,
        p.content AS post_snippet
      FROM post_comments c
      JOIN users u ON c.author_id = u.user_id
      JOIN posts p ON c.post_id = p.post_id
      ORDER BY c.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const result = await req.db.query(query, [limit, offset]);

    const thoughts = result.rows.map(row => ({
      id: row.id,
      content: row.content,
      created_at: row.created_at,
      author: row.author,
      author_id: row.author_id,
      post_id: row.post_id,
      avatar: row.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(row.author)}&background=e0e7ff&color=3730a3`,
      postSnippet: (row.post_snippet && row.post_snippet.length > 50)
        ? row.post_snippet.substring(0, 50) + '...'
        : row.post_snippet
    }));

    res.json({
      thoughts,
      totalThoughts,
      currentPage: parseInt(page, 10),
      totalPages: Math.ceil(totalThoughts / limit)
    });
  } catch (error) {
    console.error('Error fetching all thoughts:', error);
    res.status(500).json({ error: 'Failed to fetch thoughts' });
  }
};

// DELETE /api/admin/feed/thoughts/:id
exports.deleteThought = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await req.db.query('DELETE FROM post_comments WHERE comment_id = $1 RETURNING *', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Thought not found' });
    }

    res.json({ success: true, message: 'Thought deleted successfully' });
  } catch (error) {
    console.error('Error deleting thought:', error);
    res.status(500).json({ error: 'Failed to delete thought' });
  }
};

// GET /api/admin/feed/posts/:id/likes
exports.getPostLikes = async (req, res) => {
  try {
    const { id } = req.params;
    const query = `
      SELECT 
        pl.like_id AS id,
        pl.created_at,
        u.user_id AS "userId",
        u.full_name AS author,
        u.avatar_url AS avatar,
        u.job_title AS title,
        u.company_name AS company
      FROM post_likes pl
      JOIN users u ON pl.user_id = u.user_id
      WHERE pl.post_id = $1
      ORDER BY pl.created_at DESC
    `;
    const result = await req.db.query(query, [id]);
    res.json(result.rows.map(row => ({
      id: row.id,
      userId: row.userId,
      author: row.author,
      title: row.title || 'Platform Member',
      company: row.company || '',
      avatar: row.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(row.author)}&background=e0e7ff&color=3730a3`,
      created_at: row.created_at
    })));
  } catch (error) {
    console.error('Error fetching post likes:', error);
    res.status(500).json({ error: 'Failed to fetch post likes' });
  }
};

