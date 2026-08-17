# Model design principles

**Status:** Long-lived

This is the canonical guide for choosing model types, model boundaries, methods,
and resources in this repository. Future extensions and model definitions
should follow this document.

This document records stable model design decisions and should remain useful
after individual migrations are complete. The stable remote transport boundary
is documented in [`remote-execution.md`](./remote-execution.md).

## Evidence and vocabulary

The cloned `@adam/cfgmgmt` extension demonstrates the repository's supported
model namespace shape:

```text
@adam/cfgmgmt/file
@adam/cfgmgmt/directory
@adam/cfgmgmt/systemd
```

Its manifest maps nested source paths such as
`adam/cfgmgmt/systemd.ts` to those model types. `swamp model type search
cfgmgmt --json` confirms that multiple `/` segments are valid model type names.

Use the shape:

```text
@collective/domain/resource
```

The domain segment names the external system or family. The final segment names
the resource contract. A type name is user-facing API; choose it for long-term
clarity, not for a current implementation folder or method name.

## Core principles

### 1. One model type, one resource contract

A model instance should have one clear owner, identity, desired state, current
state, and lifecycle. Methods act on that resource; methods are not separate
model types.

Good examples:

```text
@adam/cfgmgmt/file
@adam/cfgmgmt/directory
@holi0317/systemd/unit
@holi0317/systemd/quadlet
@holi0317/postgres/database
```

Avoid a catch-all type with a large `kind` union when the kinds have different
paths, lifecycle rules, or state interpretation. Conversely, do not create a
new type for every filename extension when the resource contract and lifecycle
are the same.

### 2. Split types only when semantics split

Create separate types when at least two of these differ materially:

- global argument schema and required identity;
- desired-state invariants or validation;
- remote paths or ownership boundaries;
- generated resource names;
- lifecycle transitions or idempotency rules;
- resource/data schemas or failure interpretation;
- available methods and their meanings.

A split must remove ambiguity, not merely move a conditional into another file.
Raw systemd unit suffixes share one lifecycle and should remain one `unit` type.
Quadlet suffixes share one source-file contract and should remain one `quadlet`
type. Do not create `/service`, `/timer`, `/network`, or `/volume` types only
because those suffixes exist.

### 3. Prefer existing models before creating custom ones

Before adding a type:

1. Search the registry and local model catalog.
2. Describe candidate types and compare their methods and schemas.
3. Use an existing type when its resource contract fits.
4. Extend or request a missing capability when appropriate.
5. Create a custom extension only for the remaining gap.

`@adam/cfgmgmt/systemd` is the starting point for conventional systemd
services and unit files. Its `check` / `apply` / `restart` / `logs` shape and
compliance-oriented state resource are useful baselines. It is already used by
`models/bootstrap/journald-restart.yaml`.

Reuse is not a goal by itself. A custom type is justified when the existing
contract would require duplicated connection credentials, bypass the repository
`@swamp/ssh` fleet, misrepresent a different resource kind, or omit required
ownership and lifecycle behavior. The current Quadlet requirements are one
such gap. Do not copy `@adam/cfgmgmt/_lib/ssh.ts`; it implements a separate SSH
client. Use the shared adapter described in `remote-execution.md`.

### 4. Model desired state; make actions explicit

Declarative resources should converge toward desired state:

- `check` reports compliance without mutation;
- `apply` performs the minimum required in-place changes;
- `destroy` removes state owned by the model when destruction is meaningful.

Imperative operations such as `restart`, `rotate_password`, and `logs` may be
methods, but their descriptions and output must identify them as actions or
observations rather than convergence. A successful observation must not be
reported as a mutation merely because its command exited zero.

Models may use domain-specific names such as `deploy` when deployment is the
actual contract, but they must still distinguish desired state, current state,
and mutation boundaries.

### Desired lifecycle belongs in global arguments

Desired state is part of the model definition and should be available to every
method, so lifecycle requirements belong in global arguments rather than only
on `apply`. Invocation-specific consent and execution controls remain method
arguments.

For systemd-family models, use optional desired-state fields:

```ts
const GlobalArgsSchema = z.object({
  enabled: z.boolean().optional().describe(
    "If provided, converge whether the resource is enabled",
  ),
  state: z.enum(["running", "stopped"]).optional().describe(
    "If provided, converge the active state",
  ),
});
```

Omitted means leave that dimension unchanged. `enabled: false` means ensure
disabled; `state: "stopped"` means ensure inactive. This avoids ambiguous
boolean action flags such as `start: false`, which could mean either "do not
start" or "ensure stopped".

`allowRecreate` remains an `apply` method argument because it is explicit
per-invocation consent for a destructive operation, not desired resource
state.

### 5. Destructive replacement requires explicit consent

Some drift cannot be repaired in place. Examples include changing an immutable
resource identity, changing a systemd unit name, changing a Quadlet source name,
or replacing a resource whose only safe update is destroy-then-create. This is
analogous to Terraform replacement behavior.

Any model whose `apply` method can require destructive replacement MUST expose an
`allowRecreate` method argument:

```ts
const ApplyArgsSchema = z.object({
  allowRecreate: z.boolean().default(false).describe(
    "Permit destroy-then-create when the desired state cannot be applied in place",
  ),
});
```

The serialized model input uses the same camelCase spelling:

```yaml
methods:
  apply:
    arguments:
      allowRecreate: false
```

Rules:

1. The default is `false`.
2. The model must detect and classify replacement drift before mutating.
3. When replacement is required and `allowRecreate` is false, the method must
   fail without stopping, deleting, or partially replacing the resource.
4. The method must persist diagnostic state explaining that recreation is
   required and identify the old and desired identities where safe.
5. When `allowRecreate` is true, the method may perform an explicit
   destroy-then-create sequence and must record that replacement occurred.
6. Cleanup failures must fail the method and leave an actionable diagnostic
   resource; they must never be hidden as ordinary drift.
7. Models that can converge entirely in place should not add this flag merely
   for symmetry.

`allowRecreate` is a safety gate, not a request to recreate on every apply. The
normal path remains idempotent in-place convergence.

### 6. Resources are the durable contract

Every mutating or diagnostic method should write typed data answering:

- what resource was targeted;
- what desired state was evaluated;
- what current state was observed afterward;
- what changes were detected or applied;
- whether the result was compliant, applied, replaced, failed, or observed;
- what error and timestamp belong to the result.

Use stable resource names for the same logical resource. Do not put a random
operation ID in the primary state resource. Keep noisy command output in a
separate run or observation resource when it would make state comparison
unhelpful.

Never put credentials, private keys, database passwords, or sensitive command
arguments in resource attributes, tags, logs, or error messages.

### 7. One source of truth for transport

Model types describe remote resources, not transport implementations. Remote
custom models use the shared adapter and the `@swamp/ssh` fleet. They must not
create private SSH pools, invoke local SSH binaries, or duplicate
authentication, multiplexing, and retry policy.

Connection identity should be a reusable fleet/host reference. Domain options
such as system/user mode, container name, database name, and resource paths
remain in the owning model.

### 8. Workflows orchestrate; models do not become workflows

A model method manages one resource and returns typed data. Workflows own
ordering, fan-out, dependencies, guards, and cross-model coordination.

Do not add a model type solely to sequence several existing methods. Do not hide
a multi-resource deployment graph inside a model whose resource identity is
unclear. If a model intentionally produces multiple resources, use a
well-defined factory contract and document each output identity.

### 9. Errors and expected non-zero exits are explicit

Schemas should reject invalid identities before remote work. Methods should
write diagnostic data before raising an error when the framework permits it.
Expected non-zero command exits must be explicit; never treat every non-zero
exit as success to make a probe convenient.

Replacement-required drift is a distinct error from an execution failure. It
should be queryable and actionable, not represented as a generic shell error.

### 10. Test the observable contract

Test model logic at three levels:

1. pure state and command builders without a host;
2. fake transport/context tests for resource, replacement, and error behavior;
3. one real smoke scenario through the declared fleet.

At minimum, replacement-capable models need tests for:

- no drift and ordinary in-place drift;
- replacement drift with the default false flag;
- replacement drift with `allowRecreate: true`;
- failure during destroy and failure during create;
- persisted diagnostic data for each failure transition.

A model is not complete when it only compiles; its observable data contract and
failure transitions must be verified.

## Systemd model family

The intended custom family is:

```text
@holi0317/systemd/unit
@holi0317/systemd/quadlet
```

`unit` owns one raw systemd unit or pre-existing conventional unit. `quadlet`
owns one Quadlet source file and its generated systemd unit. They share remote
transport and lifecycle helpers but do not share a `kind` union in their public
schemas.

A unit-name change is replacement drift because it changes the managed file
identity and potentially the generated runtime identity. The `apply` method
for both types must use the `allowRecreate` rule above. Ordinary content,
enablement, and active-state changes should remain in-place when systemd
supports them.

`@adam/cfgmgmt/systemd` remains a valid starting point and may continue to own
simple conventional systemd resources. The custom types exist when the
repository needs the fleet reference, Tailscale behavior, tracked-file
ownership, Quadlet semantics, readiness behavior, or replacement safety that
the existing type does not provide.

Do not add speculative types for logs, readiness, masks, presets, or drop-ins.
Create one only when it has independent desired state, ownership, and lifecycle
that cannot be represented clearly as a method/resource of `unit` or `quadlet`.

## PostgreSQL model family

The PostgreSQL model family owns separate, independently managed resources:

```text
@holi0317/postgres/role
@holi0317/postgres/database
@holi0317/podman/secret
```

`postgres/role` manages one cluster role and its password without persisting the
password. `postgres/database` manages one logical database owned by a single
`LOGIN` role. For existing databases, an ownership change reassigns objects owned
by the previous database owner in that database before changing the database
owner; it does not rewrite objects owned by unrelated roles or change ACLs.

The applications currently in scope perform schema migrations through their
normal database connection, so each application role is both its runtime role
and database owner. The model family intentionally does not expose speculative
reader, writer, or migrator abstractions.

`podman/secret` is independent of PostgreSQL. Application workflows may point
the role password and Podman secret value at the same vault expression, but
neither resource owns the other.

The bootstrap PostgreSQL role and database are adopted after the container is
ready. Bootstrap environment variables initialize an empty cluster only; live
role passwords are converged by the PostgreSQL role model.

Database replacement or destruction can destroy data. Destructive methods are
gated explicitly, and role destruction does not implicitly drop owned objects.

## Definition of done for a new model type

- The type name identifies a stable resource contract.
- Existing registry and local models were searched and considered.
- The model owns one clear resource identity and lifecycle.
- Global arguments, method arguments, resources, and errors are typed.
- Declarative convergence is separated from imperative actions.
- Destructive replacement is impossible by default and gated explicitly when
  applicable.
- Remote transport is delegated to the repository's chosen adapter/model.
- Secrets are excluded from persisted and diagnostic data.
- At least one plausible alternative boundary was rejected in writing.
- Pure logic tests, fake-context tests, and a real smoke scenario exist where
  the model performs remote work.
- The manifest, model catalog, workflows, and design documentation agree.
