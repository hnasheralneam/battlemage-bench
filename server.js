const app = require('./src/app');
const config = require('./src/config');

app.listen(config.port, () => {
  console.log(`Battlemage Benchmarks listening on http://localhost:${config.port}`);
});
