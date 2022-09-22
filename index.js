const app = require('./src/api');

if (!module.parent) {
  const port = 3000;
  app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });
}

module.exports = app;
