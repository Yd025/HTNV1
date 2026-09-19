// Run after build_sim_models.py. Uses the repository's existing drei dependency.
const fs = require("node:fs");
const path = require("node:path");
const { MeshoptSimplifier } = require("meshoptimizer");

(async () => {
  await MeshoptSimplifier.ready;
  const filename = path.join(__dirname, "simModels.json");
  const models = JSON.parse(fs.readFileSync(filename, "utf8"));
  for (const [kind, model] of Object.entries(models)) {
    let total = 0;
    for (const part of model.parts) {
      if (part.type !== "mesh") continue;
      const limit = part.name === "base_link_visual" ? (kind === "copter" ? 10000 : 5000) : 750;
      const [indices, error] = MeshoptSimplifier.simplify(
        new Uint32Array(part.indices), new Float32Array(part.positions), 3,
        Math.min(part.indices.length, limit * 3), 0.006,
      );
      const used = [...new Set(indices)].sort((a, b) => a - b);
      const remap = new Map(used.map((index, position) => [index, position]));
      part.positions = used.flatMap((index) => part.positions.slice(index * 3, index * 3 + 3));
      part.indices = Array.from(indices, (index) => remap.get(index));
      part.simplificationError = error;
      total += indices.length / 3;
    }
    model.processing = "Static visual geometry only; source poses preserved, CAD detail clustered and meshoptimizer simplified (relative error target 0.006). Palette materials replace simulator textures.";
    console.log(`${kind}: ${total} mesh triangles`);
  }
  fs.writeFileSync(filename, JSON.stringify(models));
  console.log(`Total geometry: ${fs.statSync(filename).size} bytes`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
