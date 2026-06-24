const fs = require('fs');
let code = fs.readFileSync('src/index.js', 'utf8');

const glmRoutes = `
// GLM Monitor API Mocks
app.get('/glm/api/usage', (c) => {
  return c.json({
    success: true,
    data: {
      level: 'Premium',
      limits: [
        { type: 'TOKENS_LIMIT', usage: 1200000, limit: 5000000, resetInSec: 3600 },
        { type: 'TIME_LIMIT', usage: 15, limit: 100, resetInSec: 86400 }
      ]
    }
  });
});
app.get('/glm/api/model-usage', (c) => {
  return c.json({
    success: true,
    data: {
      totalUsage: { totalTokensUsage: 45000000 },
      daily: [ {date: '2026-06-20', usage: 100}, {date: '2026-06-21', usage: 200} ]
    }
  });
});
app.get('/glm/api/system-status', (c) => {
  return c.json({ success: true, data: { speed: 1.5 } });
});
`;

if (!code.includes('/glm/api/usage')) {
  code = code.replace('export default app', glmRoutes + '\nexport default app');
  fs.writeFileSync('src/index.js', code);
}
