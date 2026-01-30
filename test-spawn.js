const { spawn } = require("child_process");
const args = ['test with "quotes" inside'];
const proc = spawn("node", ["test-args.js", ...args], {
  shell: true,
  stdio: "inherit"
});
proc.on("close", () => {
  require("fs").unlinkSync("test-args.js");
});
