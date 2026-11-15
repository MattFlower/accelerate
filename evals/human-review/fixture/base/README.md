# Parcel Desk

Parcel Desk is the process-local core of an order intake service. A transport
adapter supplies request-shaped objects to the handlers. Storage is volatile;
restarting the process discards orders, replay tokens, queued deliveries.

Run all checks with Node 18 or newer:

```sh
node --test test/*.test.mjs
```

No package installation is required. All monetary values are integer cents.
Orders progress from pending to paid to shipped, or from pending to cancelled.
Clients can supply an idempotency-token header when submitting an order.
Tokens are retained for the lifetime of the store. Reads return detached values.
The repository checks versions on writes to reject stale updates.

The retry scheduler is driven by an external timer calling tick. Each tick
processes the jobs due when it began. A delivery adapter marks transient errors
with retryable=true. The configured attempt count includes the first delivery.
The default retry policy doubles the delay until it reaches a fixed ceiling.

Reporting provides a bounded CSV iterator without constructing a full export in
memory. Capabilities authenticate internal reporting adapters; secrets come from
the host process. Neither the core nor its tests opens a network listener.

Source areas: orders contains lifecycle operations; storage owns row isolation;
http translates request values; retry owns due-work scheduling; reporting owns
CSV output; security owns signed capabilities; config validates environment input.
