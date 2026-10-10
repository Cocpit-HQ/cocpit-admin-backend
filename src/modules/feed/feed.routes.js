const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const feedController = require('./feed.controller');

router.get('/metrics', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getFeedMetrics);
router.get('/posts', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getFeedPosts);
router.get('/posts/:id', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getPostById);
router.get('/posts/:id/comments', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getPostComments);
router.post('/posts/:id/comments', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.createPostComment);
router.delete('/posts/:id', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.deleteFeedPost);
router.post('/posts/:id/restore', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.restoreFeedPost);
router.post('/posts/:id/reject-appeal', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.rejectFeedPostAppeal);
router.get('/hashtags', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getTrendingHashtags);
router.get('/leaderboard', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getFeedLeaderboard);
router.get('/thoughts', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getAllThoughts);
router.delete('/thoughts/:id', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.deleteThought);
router.get('/channels', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getAllChannels);
router.get('/channels/:id/articles', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getChannelArticles);

module.exports = router;
