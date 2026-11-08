# Video Studio

`@ruyix/video` adds the `video.edit` workflow and a native Video Studio to Ruyix.
Projects, source media, active work, deliverables and delivery dates use the
existing Studio and Workbench stores. No separate browser editor runtime is
required. Original footage is read only.

## Start a project

1. Install a local FFmpeg build with `ffprobe`, `libx264` and the AAC encoder.
   The setup page checks these dependencies. On macOS, an existing Homebrew
   FFmpeg installation works. Pack settings `ffmpeg` and `ffprobe` can name
   explicit executable paths if they are not on the server's PATH.
2. In Video Studio, create a project with a title and editing brief. Upload
   source videos up to the Workbench's 25 MiB browser-upload limit, or give an
   **absolute local source folder** and one **relative video path per line**.
   Local paths are interpreted on the machine running Ruyix. Large sources are
   streamed and hashed; they are not converted to base64 or loaded into memory.
3. Choose landscape, portrait or square output and an initial duration. The
   default builds a deterministic initial assembly for manual editing. Enable
   agent assistance to ask the configured editor role to revise the plan using
   the brief, inspected sources and previous user feedback. An agent must state
   when it has not actually inspected the footage; metadata is not scene vision.
4. In the timeline review, play source footage, set in/out points at the
   playhead, trim, reorder, add/remove clips, adjust speed/gain and select output
   settings. The JSON editor also supports caption cues. Save validates the
   complete edit and records a new Workbench version. Concurrent stale saves
   and approval while a save is running are rejected. Switching to an evidence
   file preserves the editor draft; closing with unsaved changes requires an
   explicit discard confirmation.
5. Approve the timeline to render a real MP4 preview (long edge at most 640 px).
   Review cuts, audio and subtitles. Approving that exact preview enables the
   full-resolution render. Review the final MP4 before marking it deliverable.
   Download the MP4, export manifest and optional VTT subtitles from the review.
   No publication action is included. Rendered MP4, VTT and manifest files are
   read only in the Workbench editor; edit captions in `timeline.json` and
   render a new reviewed deliverable.

The workflow is **intake → inspect → plan → timeline review → preview render →
preview review → export → final review → report**. All three review gates use
the common review, comment, version and feedback system. Scores and written
feedback are scoped by the shared Studio feedback implementation, and the next
agent-assisted plan receives the run's `studioPreferences` snapshot through the
common brief header. This is preference conditioning, not model-weight training
or proof of improvement before users provide comparable ratings.
Tasks “再改” and Results comments return to the plan and timeline review before
rendering again. Assisted plans include `edit-notes.md` in that review so
uninspected footage and unresolved questions remain visible. An existing invalid
timeline is preserved with its validation error; repair it in the file editor
instead of losing cuts to a new initial assembly.

Timeline, preview and final-video feedback is routed to the next assisted plan.
Manual assembly does not consume creative preferences: enable **Agent-assisted
edit plan** to use them. Caption preferences never authorize invented speech.

## Supported editing contract

- MP4/M4V/MOV, WebM/MKV, AVI, MPEG/MPG, TS and OGV local source containers;
  decoding requires support in the installed FFmpeg build. Browser playback of
  original media depends on browser codec support; rendered MP4 is H.264/AAC.
- At most 20 sources, 10 GiB each; known video-stream duration up to 24 hours and
  dimensions up to 8192 px. A longer audio track does not extend the editable
  video range. Imports without stream duration metadata must be remuxed first;
  existing imports need reinspection to update their recorded video boundary.
  One output is limited to 100 clips and 30 minutes.
- Stable clip IDs, half-open source ranges, hard cuts, speed from 0.5× to 2×,
  gain from 0 to 2, contain/cover fitting, even dimensions from 128 to 1920 px,
  at most 1920×1080 pixels, output rates 24/25/30/50/60 fps, CRF 16–30.
- Every clip resolves to complete frames at the output frame rate. The player,
  caption timing, render and manifest use the same clock. Fractional-frame
  in-points retain their timing relative to audio; EOF rounding may duplicate
  up to one source-frame interval plus one output frame, bounded by the approved
  clip duration. Audio is normalized
  to stereo 48 kHz; silent sources get actual silent audio. Optional loudness
  processing requests −16 LUFS, −1.5 dB true peak and LRA 11; human listening is
  still part of review.
- Up to 1000 ordered, non-overlapping caption cues in final-output seconds.
  Captions become an MP4 soft-subtitle track and a VTT sidecar shown in the
  browser player. They are **not burned into the image**. Captions are supplied
  or verified by the person/agent; this pack does not run automatic ASR.

`timeline.json` contains `version: 1`, `title`, `output`, `clips` and `captions`.
Clip fields are `id`, `source`, `in`, `out`, `speed`, `volume`, `reason`. Caption
fields are `id`, `start`, `end`, `text`. `sources.json` records inspected media;
the authoritative source allowlist is stored on the run, so an edited JSON file
cannot redirect the renderer to a new filesystem path.

## Validation, safety and recovery

FFmpeg runs without a shell using generated argument arrays. EDL input cannot
add filters, protocols or CLI arguments. The renderer disables network protocols
and playlist demuxers for source media, checks workspace-relative paths and
rejects symlink components. Large-file playback names only a registered run and
source ID; clients cannot provide arbitrary paths. Playback refuses sources
whose size or modification time changed after import.

Imports record streaming SHA-256 hashes. Rendering verifies source hashes both
before and after encoding. A changed source must be imported and reviewed again.
Preview approval binds the exact timeline, source inventory and rendered preview
hash; stale approvals cannot authorize changed footage. Each render writes to
its own scratch folder. Commands have bounded logs, a 10 minute per-command
deadline and a 30 minute render-command budget. Cancellation sends SIGTERM then
SIGKILL if necessary. Failed/cancelled scratch output is removed, and no partial
movie is advertised as completed. Re-running a render keeps old verified movies
under unique names; the current review points to its new immutable evidence.

Final checks probe actual duration, dimensions and codecs, then decode the entire
file with FFmpeg's error-on-decode mode. Evidence is copied as a file stream
without allocating a movie-sized Buffer. The manifest records source hashes,
the exact EDL, FFmpeg versions, normalized command arguments, measured output,
QA results and the output checksum. It supports reproduction with the same
inputs and toolchain; it does not promise identical bytes across FFmpeg versions.

There is no automatic transcription, waveform editing, transition compositor,
multitrack drag editor, HDR/color-managed finishing, background music/narration,
GPU queue, OTIO/NLE interchange or automatic publishing in this release. Native
long-media and browser playback testing on representative user footage remains
a release-validation task. User ratings cannot replace technical QA.

## Research and license notes

See [the source-backed research record](../../docs/research/creator-studios.md)
and the bundled [video-editing skill](skills/video-editing/SKILL.md). The skill
applies independently written guidance from official Auto-Editor, HyperFrames
and Remotion skills: inspect before editing, stable IDs, a shared clock,
preserved user revisions, speech margins and explicit preview/export QA.

Pica and DramaCut were read as local architectural references; their specialized
short-drama renderers were not copied. No upstream editor/runtime or skill source
is vendored. Desktop runs detect the user's FFmpeg installation; the Ruyix box
image installs Debian's FFmpeg package. Distribution of that image must retain
the package's applicable notices and source obligations; libx264 requires a
GPL-enabled FFmpeg build. Remotion's
custom runtime license is not introduced as a dependency here.

## Development

Run `npm run build --workspace @ruyix/video` and
`npm run check --workspace @ruyix/video`. Checks exercise declarations, EDL
validation, path rejection, subprocess cancellation/timeouts, version-bound
approval/save concurrency and a real FFmpeg integration fixture with audible
and silent sources, different aspect ratios/frame rates, cut-boundary pixels,
decoded audio, caption streams, preview dimensions and export hashes.
Regression fixtures also cover 29.97/23.976 fps EOF trims at normal/half speed,
exact decoded frame and audio lengths, synchronized flash/tone timing, and
video-versus-container duration in MP4, Matroska and MPEG-TS sources.
`engine-check.mjs` also runs a real Studio → Workbench lifecycle with FFmpeg,
all three human review gates, source/output HTTP Range playback, VTT content
type, exact decoded frame counts, streamed ledger verification, raw-file/save
concurrency, read-only render outputs, resumed gate media, Tasks/Results revision
routing and assisted-plan disclosures. `ui-check.mjs` mounts the real React
editor in Chromium to exercise stale/draft races, per-gate media and playhead
bounds. Its optional
agent service is a deterministic fixture, not a live model quality evaluation.

The native integration test explicitly skips when FFmpeg/ffprobe are missing;
that skip is not an export certification. There is no remote service required
for the native rendering checks.
