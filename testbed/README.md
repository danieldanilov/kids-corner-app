# Player testbed

Device checks for the Kids Corner player, run by Daniel on April's iPad at `https://danieldanilov.github.io/kids-corner-app/testbed/`, in Safari and from its Home Screen copy (Share › Add to Home Screen). It runs the same player code the app ships: `player/` here is a copy made by `app/player/tools/sync-testbed.sh`, so re-sync before publishing. Results stay on the device in IndexedDB `kc-testbed`; **Copy results** gives JSON with no URLs, keys or tokens, to paste back to Claude. Every step starts silent; the **Sound** button turns sound on for the listening checks.

## What each step proves

- **1. This device.** Records the model, Safari and WebKit versions, whether the page runs as a Home Screen app or a Safari tab, and which codecs ManagedMediaSource accepts. It passes when MediaSource and H.264 with AAC are there, the minimum for every TorBox path.
- **2. Settings.** The Torrentio config and the app token, typed on the iPad and kept only in its IndexedDB. The app token is the Keychain entry `kidscorner-app-token` (`../../worker/README.md`). The Torrentio config is April's manifest URL from her Stremio account.
- **3. Worker resolve.** Proves the chain from the iPad: Torrentio's list for Bluey S1E1, a ranked `[TB+]` pick, the Worker's resolve, and a 64 KB byte range read straight from the TorBox CDN. The range read is what shows the CDN link isn't bound to the Worker's IP.
- **4. Direct MP4.** 4a plays a bundled MP4 and 4b a real TorBox MP4 through the direct path. Each checks the playhead advances and the path was `direct`, and asks whether the tone was heard, since WebKit on the Mac can't meter MSE audio.
- **5. MKV remux.** Bundled MKVs through the remux path: AAC (5a), a Russian E-AC-3 track (5b), HEVC 10-bit with AC-3 (5c), and Russian MP3 in a second `audio/mpeg` buffer (5d). Then real TorBox MKVs in English (5e) and Russian (5f). Together they prove each audio codec plays with sound on this iPad.
- **6. YouTube** (without the clear layer, as today's app plays it):
  - 6a: a parent tap starts the video, or YouTube needs its own play button tapped.
  - 6b: pause hides the player and resume brings it back.
  - 6c: seeking forward and back recovers; 6c2: a +15 made while paused, as on the app's pause screen, lands when play resumes.
  - 6d: a skip loads the next video on the warm player.
  - 6e: our end screen takes over before YouTube's end panel.
  - 6f and 6g: for each tappable part of YouTube's player, start screen and ads, whether it leads out of the app. Only the logo is allowed to.
- **6h. Ads with YouTube Premium in Safari.** Plays the same video on `youtube-nocookie.com` and `www.youtube.com` after a Premium sign-in on youtube.com in Safari. Each run records whether an ad came, as seen by the player and as answered by Daniel, to show whether the sign-in reaches an embedded player.
- **6i. Clear layer and ad sound.** Plays monetised Kids Corner videos with the layer on, the way the app will once it handles `shield-tap`.
  - It samples YouTube's mute state every 250 ms and asks whether the ad was silent and whether the sound came back for the video. That proves the ad-mute rule on iOS, including that unmuting doesn't stop the video.
  - Its table arms each part of the player and of an ad. A tap the layer catches, and a Skip that ends the ad, are recorded without asking. That proves nothing leads out with the layer on, the logo included, and that Skip works through the open bottom-right quarter on this iPad.
- **6j. Premium sign-in inside the Home Screen app.**
  - Records Safari's Prevent Cross-Site Tracking setting.
  - Tries a youtube.com sign-in from inside the app, by same-window navigation and by `window.open`, and records where each opened and whether the sign-in finished. "Open youtube.com here" checks whether the sign-in stuck.
  - Then plays the same video on both hosts, recording ads per host with the sign-in state and the setting, to show whether Premium can remove ads inside the app.
- **7. Audio with the screen locked.** Plays a Kids Corner story, then measures how far it advanced while the iPad was locked, separately for Safari and the Home Screen app.

## Automated checks

From `app/player` (`../../player/README.md`, Tests):

- `test/browser/testbed-check.mjs local|pages` drives steps 3 to 6g in WebKit against real services (needs the secrets described there).
- `test/browser/testbed-yt.mjs` drives 6h to 6j against a scripted YouTube player, with no secrets.
