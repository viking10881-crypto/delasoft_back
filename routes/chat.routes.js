// routes/chat.routes.js
const express = require('express');
const router  = express.Router();
const {
  getChatUsers, getConversation, editMessage, deleteMessage,
  uploadImage, uploadChatImage, clearHistory,
} = require('../controllers/chat.controller');
const { auth } = require('../middleware/auth.middleware');

router.get('/users',                auth, getChatUsers);
router.get('/conversation/:userId', auth, getConversation);
router.put('/message/:id',          auth, editMessage);
router.delete('/message/:id',       auth, deleteMessage);
router.post('/upload-image',        auth, uploadChatImage.single('image'), uploadImage);
router.delete('/history',           auth, clearHistory);

module.exports = router;