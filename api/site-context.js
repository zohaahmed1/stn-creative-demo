const fs = require('fs');
const path = require('path');

module.exports = function handler(req, res) {
  // Allow any origin (AI tools, browsers, etc.)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  try {
    const contextPath = path.join(process.cwd(), 'SITE_CONTEXT.md');
    const content = fs.readFileSync(contextPath, 'utf-8');
    res.status(200).send(content);
  } catch (err) {
    // Fallback: inline the key context if file read fails
    res.status(200).send(`# Skip the Noise Media — Site Context

Domain: skipthenoisemedia.com
Positioning: AI creative production + performance marketing agency for DTC and SaaS brands.
Differentiators: Reddit Certified Partner, ex-WPP/GroupM, 40+ AI creatives/month, first ads live in 1 week.
Founders: Zoha Ahmed (Performance Lead), Sonia Mohapatra (Creative Strategy Lead)
Location: Toronto, Canada. Serving US + Canada.
Pricing: $8k/mo base (1 platform) + $2k/mo per additional platform.
Guarantee: 45-day performance guarantee.

For full context visit: https://raw.githubusercontent.com/zohaahmed1/stn-creative-demo/main/SITE_CONTEXT.md
`);
  }
};
