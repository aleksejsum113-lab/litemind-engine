import { Effect, Schema } from "effect"
import { createLocalProviderPlugin } from "./local.js"

/**
 * LiteMind Engine local provider.
 *
 * LiteMind Engine (see `packages/litemind-engine`) serves an OpenAI-compatible
 * API on the loopback interface, default `http://127.0.0.1:8399/v1`.
 *
 * This plugin discovers models installed & managed by LiteMind via
 * `GET /v1/models` and registers them into the OpenCode model switcher.
 * Models only appear while the LiteMind engine is running, and every
 * request goes to the user's own machine — nothing leaves the loopback.
 *
 * The optional `litemind` block in the response carries hardware-aware
 * metadata (quantization, context limit, tool support) that LiteMind's
 * low-resource manager computes locally.
 */
const LitemindMeta = Schema.Struct({
  sizeBytes: Schema.NullOr(Schema.Number).pipe(Schema.optional),
  quantization: Schema.NullOr(Schema.String).pipe(Schema.optional),
  family: Schema.NullOr(Schema.String).pipe(Schema.optional),
  contextTokens: Schema.NullOr(Schema.Number).pipe(Schema.optional),
  tools: Schema.NullOr(Schema.Boolean).pipe(Schema.optional),
  vision: Schema.NullOr(Schema.Boolean).pipe(Schema.optional),
  backend: Schema.NullOr(Schema.String).pipe(Schema.optional),
})

const RemoteModel = Schema.Struct({
  id: Schema.String,
  object: Schema.Literals(["model"]),
  owned_by: Schema.String.pipe(Schema.optional),
  litemind: LitemindMeta.pipe(Schema.optional),
})

const Response = Schema.Struct({ object: Schema.String, data: Schema.Array(RemoteModel) })

export const make = createLocalProviderPlugin({
  id: "opencode.provider.litemind",
  providerID: "litemind",
  name: "LiteMind",
  origin: "http://127.0.0.1:8399",
  stripPathSuffix: /\/v1$/,
  discover: (client) =>
    Effect.gen(function* () {
      const response = yield* client.getJson("/v1/models", Response)
      return response.data
        .filter((model) => model.id.length > 0)
        .toSorted((a, b) => a.id.localeCompare(b.id))
    }),
  model: (item) => ({
    id: item.id,
    name: item.id,
    family: item.litemind?.family ?? "litemind",
    tools: item.litemind?.tools ?? true,
    vision: item.litemind?.vision ?? false,
    context: item.litemind?.contextTokens ?? undefined,
  }),
})

export const LiteMindPlugin = make()
