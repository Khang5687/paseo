import { connectToDaemon } from "./src/utils/client.js";

const client = await connectToDaemon({ target: { kind: "instance", home: "/tmp/paseo-dup-home" } });
const timeline = await client.fetchAgentTimeline("f0da5bd8-ebe0-4089-990a-88aef53f8571", {
  direction: "tail",
  limit: 0,
  projection: "projected",
});
for (const entry of timeline.entries) {
  if (entry.item.type === "user_message") {
    console.log(
      JSON.stringify({ ...entry, item: { ...entry.item, text: entry.item.text.slice(0, 60) } }),
    );
  }
}
await client.close();
process.exit(0);
