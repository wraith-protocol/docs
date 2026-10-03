const previewUrl = process.env.MINTLIFY_PREVIEW_URL;

if (!previewUrl) {
  console.error("Set MINTLIFY_PREVIEW_URL to the base URL of the Mintlify PR preview.");
  process.exit(1);
}

let baseUrl;
try {
  baseUrl = new URL(previewUrl);
} catch {
  console.error(`MINTLIFY_PREVIEW_URL is not a valid URL: ${previewUrl}`);
  process.exit(1);
}

if (!/^https?:$/.test(baseUrl.protocol)) {
  console.error("MINTLIFY_PREVIEW_URL must use HTTP or HTTPS.");
  process.exit(1);
}

const requestUrl = new URL("/README", baseUrl);
const response = await fetch(requestUrl, { redirect: "manual" });

if (response.status < 300 || response.status >= 400) {
  console.error(`Expected ${requestUrl} to return a 3xx redirect; received ${response.status}.`);
  process.exit(1);
}

const location = response.headers.get("location");
if (!location) {
  console.error(`Expected ${requestUrl} to include a Location header; received none.`);
  process.exit(1);
}

const destination = new URL(location, requestUrl);
if (destination.pathname !== "/introduction") {
  console.error(`Expected ${requestUrl} to resolve to /introduction; Location was ${location}.`);
  process.exit(1);
}

console.log(`Verified ${requestUrl} returns ${response.status} redirect to ${destination.pathname}.`);
