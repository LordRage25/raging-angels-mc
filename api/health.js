module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    service: "raging-angels-mc",
    hosting: "vercel",
    timestamp: new Date().toISOString()
  });
};
