# Rear-card bridge integration

Third-party adaptation of Featherline, changed 2026-10-21. The opt-in setting is under Settings → Appearance → Featherline 背屏. Source base: `c9a417deb2ebee29448899134951e9ddc380b6aa` (1.4.2). Added code is distributed under the source project's GPL v3 license.

## Data path

`WidgetSnapshotRepository.writeWidgetSnapshot` → `RearCardPayload.build` → `RearCardPublisher.publish` → rear-card-bridge API 2 → card JavaScript.

The interface is a structured snapshot carried in an API 2 module ZIP, not a local HTTP endpoint. This uses the bridge's existing `UPDATE_CONTENT` / `update_content` contract. It requires no new network permission or always-running service. The widget repository's write mutex and generation checks keep the summary consistent with the current source state; bridge failures do not invalidate the normal widget update.

First binding uses the explicit Activity action `dev.finall.rearcardbridge.action.UPDATE_CONTENT` with `api_version=2`, a unique `request_id`, and a read-only content URI. Later updates call `content://dev.finall.rearcardbridge.update`, method `update_content`, with `package_uri`. A package-scoped URI grant lasts only for that operation. Foreground import grants are cleaned up when the Activity returns; disable also revokes outstanding exports.

`RearCardFileProvider` is unexported and supports read-only access to UUID-named ZIPs under `cacheDir/rearcard_exports` only. The small latest JSON is held in memory; temporary ZIPs contain the exported summary and are removed after use. Source histories and encrypted database files are not exposed.

## Payload schema 1

The ZIP contains `module.json`, `card/index.html`, `card/core.js`, `card/data.js`, and `card/main.js`. The source app writes `window.FEATHERLINE_PAYLOAD = <JSON>;` into `data.js`. Explicit `null` means clear; it must not fall back to an earlier snapshot.

```json
{
  "schema": 1,
  "source": "Featherline",
  "generatedAt": 1792576800000,
  "validUntil": 1792663200000,
  "zoneId": "Asia/Shanghai",
  "hideDetails": false,
  "today": {
    "date": "2026-10-21",
    "done": 1,
    "total": 3,
    "expiresAt": 1792598400000
  },
  "nextDose": {
    "at": 1792585080000,
    "label": "示例计划",
    "timeText": "10-21 20:18"
  },
  "nextDoseSearchLimited": false,
  "overdueCount": 0,
  "e2": {
    "generatedAt": 1792576800000,
    "windowStart": 1792573200000,
    "windowEnd": 1792580400000,
    "unit": "pg/mL",
    "times": [1792573200000, 1792580400000],
    "values": [100, 152]
  }
}
```

All times are Unix epoch milliseconds. The above values are fictitious. `e2` and `nextDose` may be null. `nextDoseSearchLimited=true` means active groups exist but no pending occurrence was found in the next 90 days. A model error suppresses only E2; schedule information remains available.

E2 samples reuse the source's logged-dose-only, calibrated widget projection and official unit conversion. Up to 2,048 finite samples around ±24 hours are exported. The card performs linear interpolation only inside this supplied interval and does not run a second pharmacokinetic model. Display units follow `homeE2DisplayUnit`.

Schedule selection uses `nextOccurrencesInPlanWindowFrom` and `buildPlanDaySchedule`, including schedule and stock-fulfillment records, partial groups, early/outside-window records, archived exclusions, and zone-aware epoch comparison. It does not assume every plan is daily. Hidden medication details are suppressed before export.

## Card lifecycle

The module ID is `dev.featherline.rearcard`, API version 2. The first frame reads the embedded payload synchronously. Stored bridge snapshots are only a fallback when the payload global is entirely absent; an explicit null clears them. All Canvas draws occur in `requestAnimationFrame`; a 60-second timer requests redraws. Hot replacement disposes old timers and callbacks. Async configuration reads cannot override a later privacy setting change.

At 30 minutes the display marks data as cached. At 24 hours, `validUntil`, a large clock rollback, or outside the source curve, it does not present old concentration as current. Today progress expires at the source zone's next midnight. Due countdowns stay due until source records change; the module cannot mark a medication taken.

The source's existing HomeWidgetManager requests background refresh every 15 minutes and on data/settings changes. Android scheduling and the rear-screen runtime are inexact. No continuous-refresh guarantee is made.

## Building and checking

Use the upstream Android toolchain: Gradle wrapper 9.4.1, AGP 9.2.1, SDK 37, and a Java 17-compatible toolchain (Gradle can run on JDK 21). Set your SDK path in local.properties. Windows paths with non-ASCII characters use the included `android.overridePathCheck=true` flag.

```text
gradlew.bat :app:assembleArm64Debug
gradlew.bat :app:testArm64DebugUnitTest --tests com.mkx.hrttracker.rearcard.RearCardPayloadTest
gradlew.bat :app:lintArm64Debug
```

If the Windows/JDK test executor cannot load compiled test classes from a non-ASCII absolute path, run `./scripts/test-rearcard-payload.ps1` from PowerShell. It uses the same Gradle-resolved runtime and JUnit tests, rewriting only project classpath entries to relative paths. See the integration root's `VERIFICATION.md` for the exact validation outcome.

The upstream build reads version information from Git. Both this distribution repository and the source ZIP contain the Android project as a directory, without its original `.git`. Before building, run the following **inside `Featherline/`** to restore its own upstream Git metadata. This preserves the modified working files, prevents the parent distribution repository from being mistaken for the Android project's version history, and preserves upstream notice URLs:

```text
git init
git remote add origin https://github.com/mkx173/Featherline.git
git fetch --depth=1 origin c9a417deb2ebee29448899134951e9ddc380b6aa
git reset --mixed FETCH_HEAD
```

For module changes, place a checkout of rear-card-bridge at `../upstream/rear-card-bridge` relative to the integration root, install its `tools/card-build` dependencies, then run from the integration root:

```text
node build-module.mjs
node --test tests/core.test.cjs tests/renderer.test.cjs
```

Compiled module resources are included with the Android project so APK builds work independently of the JavaScript toolchain. Node tests cover interpolation, true zero, unit labels, stale/expired data, midnight, countdowns, privacy, async-config races, snapshot clearing, RAF-only drawing, and hot reload. Android tests cover scheduling across days and DST, fulfilled/partial/outside-window records, archived plans, all source concentration units, and invalid/overflowing projections.

The optional sample preview uses `@napi-rs/canvas`: install that package in the integration root, then run `node preview/render-structured-card.cjs`. The supplied preview images contain fictitious data, not a device capture.

The debug APK is `com.mkx.hrttracker.debug` and uses an independent sandbox and debug signing key. It cannot update the official signed app. Export and restore an official encrypted backup, then use the adapted app for ongoing records. Real-device integration still requires validation against the user's bridge, system version, and chosen rear-screen carrier.

## Clearing and limitations

Opt-in is excluded from Android cloud/device backup. Disable rejects new publications before waiting for any in-flight update, wipes memory, revokes temporary exports, and sends a null module last. The bridge can retain the previous snapshot until the replacement card executes, and the OS may keep displaying a frozen carrier. Immediate removal of bridge-side module data requires uninstalling the module in the bridge; the display still needs a system refresh.

The source App Lock is respected by the settings dialog but cannot protect data already copied to the bridge. The integration does not publish the full history or provide medication recommendations.
