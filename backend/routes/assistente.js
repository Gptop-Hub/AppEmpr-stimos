const express = require('express');
const multer = require('multer');
const controller = require('../controllers/assistenteController');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024,
  },
});

router.post('/stt', upload.single('audio'), controller.stt);
router.post('/query', controller.query);
router.post('/session/reset', controller.resetSession);
router.post('/action/confirm', controller.confirmAction);
router.post('/action/cancel', controller.cancelAction);
router.post('/action/draft/discard', controller.discardActionDraft);
router.get('/warmup', controller.warmup);
router.post('/feedback', controller.feedback);
router.get('/cost/settings', controller.getCostSettings);
router.get('/cost/summary', controller.getCostSummary);
router.post('/cost/settings', controller.updateCostSettings);

module.exports = router;
