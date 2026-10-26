# Recovery and concurrent requests

Text IDs also contain an occurrence number within the current request. Trimming
identical results can therefore reuse an ID previously associated with another
file or read range. Before tracking or replaying file versions, the plugin checks
the stored file provenance against the current normalized path and range. A
conflict or unavailable current provenance retains the original request and
leaves the archive unchanged. Existing IDs and recovery layers remain valid.

An asynchronous operation validates both the revision and the exact stored
snapshot before returning its result, including when its callback made no
changes. A concurrent keep, forget, or statistics update invalidates that result.
The request hook retains the original request on conflict and never retries a
policy script or accounting call automatically.

The list, status, read and paste tools can make up to three attempts to read the
current state and, where applicable, apply keep protection. Each attempt starts from a fresh snapshot.
Persistent contention still returns a conflict. Paste creates the destination
only after protection commits, outside the retry loop, using exclusive creation;
an existing file or symlink is never overwritten.

Comparing stored content also rejects stale writes when a scope was deleted and
recreated with the same revision but different content. It does not distinguish
recreated scopes whose stored snapshots are byte-for-byte identical. A separate
lifecycle identifier would be required to invalidate every operation spanning
any deletion, regardless of the resulting state.
