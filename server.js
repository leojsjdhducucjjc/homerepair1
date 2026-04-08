const express = require("express");
const path = require("path");

const app = express();
const port = Number(process.env.PORT) || 3000;
const rootDir = __dirname;

app.use(express.static(rootDir));

app.get("*", (_req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.listen(port, () => {
  // Keeping this explicit helps during local startup debugging.
  console.log(`Server running at http://localhost:${port}`);
});
