const express = require('express');
const openapi = require('../../docs/openapi.json');

const router = express.Router();

const swaggerHtml = () => `
<!DOCTYPE html>
<html>
  <head>
    <title>ACM Bidding Platform API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.onload = () => {
        window.ui = SwaggerUIBundle({
          url: '/api/docs.json',
          dom_id: '#swagger-ui',
          persistAuthorization: true
        });
      };
    </script>
  </body>
</html>
`;

router.get('/docs', (req, res) => {
  res.type('html').send(swaggerHtml());
});

router.get('/docs.json', (req, res) => {
  res.json(openapi);
});

module.exports = router;
