// Shown the instant a nav link is clicked, while the next page comes from the server. Without it
// the old page stays frozen until that round trip finishes. It stays invisible for the first
// moment, so quick page changes don't flash it.
export default function Loading() {
  return (
    <p className="muted route-loading" role="status">
      Loading…
    </p>
  );
}
