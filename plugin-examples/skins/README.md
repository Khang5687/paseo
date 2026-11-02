# Skins plugin example

This example contributes one background skin, **Aurora**, to Settings → Appearance → Background.

The daemon generates a 1920×1080 gradient PNG on request (`server/png.ts` encodes it with
`node:zlib` and a CRC-32, so there are no binary assets or dependencies). The client entry calls
`client.addSkin` and loads the thumbnail and the full image through the `skin.image` RPC.

- `addSkin` is feature-detected: apps released before skins skip the contribution.
- `version` is the device cache key. Bump it when the art changes.
- Paseo enforces text contrast. The plugin only supplies the image and optional hints (`focal`,
  `intensity`, `luminance`).
- The image is cached on the device after first use, so the skin keeps working offline.
- To apply a skin from code, call `client.applySkin("aurora")`.

Register it in `$PASEO_HOME/config.json`:

```json
{
  "pluginsEnabled": true,
  "plugins": {
    "skins-example": {
      "source": "directory",
      "path": "/absolute/path/to/paseo/plugin-examples/skins"
    }
  }
}
```

Then run `paseo reload` and pick **Aurora** in Settings → Appearance → Background.
