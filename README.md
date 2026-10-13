<p align="center">
  <img src="https://github.com/KenWeTech/MILO/blob/main/MILO/public/assets/logo.png?raw=true" alt="MILO Logo" width="300"/>
</p>

# **MILO — Music Index & Library Organizer**

MILO is a self-hosted music catalog and library organization server. It presents an existing music collection as a browsable index, allowing authenticated users to build and manage their own personal music libraries without making a separate physical copy of tracks.

## What MILO Does

MILO has two connected jobs: if programed it can organize incoming music into the master collection, and it can build separate personal libraries from that collection.

```text
        Incoming audio files
         Dump / staging folders
                  |
                  v
          +------------------+
          |   MILO Organizer |
          | Embedded tags    |
          | Naming script    |
          | Duplicate review |
          +------------------+
                  |
                  v
       +------------------------+
       | Master Music Collection|
       |     Original audio     |
       +------------+-----------+
                    |
                    v
          +------------------+
          | MILO Music Index |
          | Browse / Search  |
          +--------+---------+
                   |
          User selection or sync
          Personal Text Playlist
                   |
                   v
          +------------------+
          | User's MILO      |
          | personal library |
          | links to sources |
          +--------+---------+
                   |
                   v
          Plex, Navidrome, or
        compatible media software
```

The Organizer uses embedded tags and a configurable naming script to place staged files into the folder structure you choose. The default layout groups by album artist, then album (or a title-based `(Single)` folder when no album tag is available), with track/disc information and format details available in the resulting paths and filenames. When a candidate is ambiguous or conflicts with an existing file, it can be held for review. The catalog and personal-library features then let multiple people select different music without requiring a separate physical copy for every user. To activate the Organizer at least one `Dump Folder` and a `Trash Folder` needs to be configured.
Rather than making a complete copy of the music collection for every user, MILO creates user-specific library structures with **symbolic links** to the original files, or **hard links** when Advanced Mode and the underlying filesystem support them.

One collection can therefore support multiple personal libraries without using additional music-file storage every time someone wants a different selection. Favorite the songs you like because you can, without needing to duplicate music or change your tags just to separate libraries.

## Core Features

* **Searchable master catalog** — Browse, search, sort, and filter an indexed view of the music in the master collection.
* **Personal music libraries** — Give each account its own track selection and library path without forcing everyone to maintain the same library.
* **Two library-linking modes** — Use symbolic links in Standard Mode or hard links in Advanced Mode when the filesystem supports them.
* **Non-destructive library selection** — Add or remove selections from a user's library without intentionally deleting the original master-pool audio files.
* **Music Organizer** — Process incoming files from configured dump/staging folders and place them into a tag-driven folder structure using a configurable MusicBrainz Picard-style naming script. This feature is optional and renenaming the audio files themselves is an option.
* **Duplicate and metadata review** — Compare embedded metadata and file details, review duplicate files, path conflicts, possible matches, and quality upgrades, and choose how each uncertain case should be handled instead of blindly overwriting a file if you use Organizer.
* **Quick Scan and Detailed Full Scan** — Check for new or changed music, run deeper catalog refreshes, process organizer staging folders, and reconcile recognized moved or upgraded files.
* **Plain-text Personal Text Playlist** — Keep a saved artist/title list independent of provider websites and APIs, including entries that cannot yet be matched to a file in the catalog.
* **Text Playlist API** — Let external apps, automations, and shortcuts add tracks to a user's saved Text Playlist through a user-specific API key.
* **Playlist provider imports** — Import playlists from Spotify, YouTube Music, and Apple Music when their accessible playlist data is available.
* **Import preview and matching review** — Check tracks to add, tracks already in the library, and unmatched entries before applying a manual import.
* **Unmatched Logs and Restore Tracks** — Revisit unmatched entries, review or correct possible matches, undo supported changes, and restore previous library selections.
* **Dead Files recovery** — Find catalog paths that no longer exist and repair entries when a verified replacement file is available.
* **Scheduled maintenance and sync** — Configure Quick Scan, Detailed Full Scan, and user sync schedules while MILO coordinates maintenance and sync work.
* **Progressive Web App** — Install MILO on supported devices and use its offline fallback when the browser's secure-context and certificate requirements are met.
* **Local network discovery** — Discover the server as `milo.local` on networks and container setups where mDNS traffic is supported.
* **Administrator tools** — Manage accounts, roles, library paths, linking modes, scan settings, organizer review, provider credentials, and catalog maintenance from the web interface.

MILO is **not a music player**. It builds the catalog and filesystem libraries, and it can organize incoming music. Compatible software such as Plex, Navidrome, or another media application can use the resulting libraries for playback and media management. MILO does **not** edit metadata.

## Why MILO?

Traditional music servers generally focus on **playing** a collection as a whole. You should not have to waste storage or change your favorite music tags just to separate your music into different libraries.

A common workaround is to use a music server's **Favorites** feature: favorite the songs you want, then configure the server to expose only those favorites. Favorites are useful for marking music you actually want to favorite. They should not have to become a substitute for having a separate library.

MILO focuses on **both music organization and organizing access to a collection**. Its Organizer if configured can process incoming files from staging folders, use embedded tags and a configurable naming script to build a consistent folder structure, and send uncertain matches or destination conflicts to review rather than blindly overwriting files. The catalog and the Organizer work together to keep the pool usable as files are added, moved, or upgraded.

From that collection, each person can choose the music they actually want in their own library without everyone being forced to use the same collection and resorting to Favorites as a library-separation workaround. The result is one collection that can be organized and maintained centrally while still supporting distinct personal libraries.

### One collection. Many libraries. No unnecessary duplication.

## How It Works

### 1. Point MILO at the master collection and configure incoming folders

MILO indexes an existing master music collection; it does not need to copy that entire collection into a new location. Administrators can also configure one or more **Dump Folders - Staging** locations for new or unorganized files, folders that should be exempt from catalog indexing, and a dedicated Trash folder for organizer review. A configurable MusicBrainz Picard-style naming script controls the destination folder structure. The option to rename audio files using that script can be enabled or left off.

### 2. Scan the collection and organize staged files

**Quick Scan** checks paths, file sizes, and modification times to find new or changed files, then hashes those files and refreshes their embedded metadata. **Detailed Full Scan** performs a deeper hash and metadata pass across the master pool, processes configured staging folders, and reconciles recognized moved or upgraded paths. Use a Detailed Full Scan for initial catalog setup or when a file may have changed without a corresponding size or timestamp change.

During organizer processing, MILO reads embedded tags and checks file identity before deciding whether a staged item can be placed at the destination generated by the naming script. Files with incomplete metadata, duplicates, destination conflicts, or possible matches can be queued for review. The Organizer Review tools let the administrator compare the candidate with the existing pool file and choose an appropriate action. When a configured Trash folder is available, duplicates and replaced versions can be staged there for review.

### 3. Browse the catalog and select music

Users sign in to browse, search, sort, and filter the catalog built from the master collection. They can add individual tracks or select a group of tracks using a saved Personal Text Playlist, a supported provider playlist, or a manual import preview.

### 4. Build a personal library without duplicating the audio

MILO creates a user's library structure using filesystem links to the source music. Standard Mode uses symbolic links; Advanced Mode uses hard links when the storage and filesystem support them. The underlying source audio is not copied once for every user.

### 5. Sync and maintain each library

Normal playlist sync is additive: matching tracks can be added, while existing selections are not removed just because they are absent from a playlist. The optional **One-for-One Playlist Mirror** mode instead makes the configured playlist define which library selections remain. Users can review unmatched entries, restore previous selections, and remove tracks from their own libraries. Administrators can run catalog scans and Dead Files checks as the master pool changes.

Removing a selection from a user's MILO library removes that user's library reference; it does **not** intentionally delete the source audio. Organizer actions are separate: depending on the review decision and configured locations, the Organizer can move or rename staged audio files in the master-pool workflow.

## Library Linking Modes

MILO supports two ways of representing files in user libraries.

### Standard Mode

Standard Mode uses **symbolic links**. A file shown in a user library points back to the original file in the master collection rather than being copied into that library.

This is the default and generally recommended mode. Symbolic links are widely supported, but some media applications or library configurations may not follow or discover them as expected.

### Advanced Mode

Advanced Mode uses **hard links** instead of symbolic links. A hard link refers to the same underlying file data without making another physical copy of the music.

Hard links have stricter filesystem requirements than symbolic links. The source and destination must satisfy the operating system and filesystem's hard-link requirements and, where required, reside on the same filesystem/physical volume. Network shares, virtual filesystems, and container volume layouts can prevent hard linking even when both paths are visible.

### Plex and Advanced Mode

If you intend to use MILO-generated libraries with **Plex**, you may need Advanced Mode. Depending on how Plex is installed and how its library path is mounted, Plex may not properly discover or display music represented by symbolic links. Hard links can allow Plex to see those entries as regular filesystem files without duplicating the underlying file data.

If Plex does not show a Standard Mode library correctly, Advanced Mode is worth trying when the storage supports hard links. Other media applications may handle symbolic links differently, so Standard Mode remains the best starting point unless you have a specific reason to use hard links.

## Example: One Source File, Separate Libraries

The master collection stores the actual audio files. Each personal library contains a filesystem link to the selected source file rather than a second copy of its audio data. For example:

```text
/music
└── Artists
    └── Artist A
        └── Album
            └── 01 - Track.flac

/app/MILO_Libraries/alice
└── Artists
    └── Artist A
        └── Album
            └── 01 - Track.flac -> /music/Artists/Artist A/Album/01 - Track.flac

/app/MILO_Libraries/bob
└── Artists
    └── Artist B
        └── Album
            └── 02 - Another Track.flac -> /music/Artists/Artist B/Album/02 - Another Track.flac
```

Alice and Bob can therefore expose different selections to their media software, even though the actual audio remains in the same master collection. The exact filesystem layout depends on each user's configured library path and linking mode.

## StableBit DrivePool Support

MILO includes support for installations using **StableBit DrivePool**.

When `DRIVEPOOL_DRIVES` is configured, MILO can search the specified physical member drives for a `PoolPart.*` directory containing the source file. In Advanced Mode, this lets MILO attempt to create the hard link against the underlying physical storage rather than the DrivePool virtual filesystem.

Configure the physical DrivePool member drives as a comma-separated list:

```env
DRIVEPOOL_DRIVES=D:,E:,F:
```

Use the actual drive letters present on your system. MILO checks the configured drives for a matching `PoolPart.*` location; this depends on the physical path being available and the corresponding file existing there.

DrivePool support does **not** remove the normal hard-link requirements. Advanced Mode still depends on filesystem support and compatible source/destination volumes. The current physical-drive bypass is intended for Windows DrivePool paths; if the underlying volume rejects the hard link, use Standard Mode or review the storage layout and permissions.

## Playlists and Synchronization

MILO's **Personal Text Playlist** is the most dependable playlist source because it is a saved list that does not depend on a provider website, provider API, or scraping result. It uses the artist and track title the user supplies, one entry per line, and remains available for future syncs. Entries that do not match the current catalog stay saved so a later sync can try again after files or metadata are added or corrected.

### Personal Text Playlist

Use one `Artist - Track Title` entry per line. For example:

```text
Daft Punk - One More Time
The Weeknd - Blinding Lights
Gorillaz - Feel Good Inc.
```

Users can create and edit their saved Text Playlist in the settings interface, select **Personal Text Playlist** as an import source, and use it with **Sync Playlist** button and scheduled syncs. The saved list is kept independently of a provider playlist. When a provider playlist is configured, Sync Playlist includes that provider playlist and the user's saved Text Playlist; when no provider is configured, the saved Text Playlist can be used on its own.

Playlist-conversion services such as [TuneMyMusic](https://www.tunemymusic.com/) can export lists from a wider range of services than MILO's three direct provider integrations. When needed, a converted list can be pasted into **Manual Import** and previewed. The **Also save these text entries to my Text Playlist for future syncs** checkbox is a convenient way to add a pasted list to the saved Text Playlist, but Manual Import is not the only or primary way to maintain it.

### Text Playlist API

A user can create a personal API key in **Sync Settings → Text Playlist API Access**. External apps, automations, and shortcuts can add a track to that user's saved list with a JSON request:

```bash
curl -X POST "http://localhost:8088/api/integrations/text-playlist" \
  -H "Content-Type: application/json" \
  -H "X-MILO-API-Key: YOUR_USER_API_KEY" \
  -d '{"artist":"Daft Punk","title":"One More Time"}'
```

Replace `localhost` with the MILO server address when calling it from another device. Both `artist` and `title` are required. Duplicate entries are ignored. Keep the API key private; it can be revoked or replaced in Sync Settings. The full key is shown when generated and is not continuously displayed afterward.

### Direct Playlist Provider Imports

MILO also supports direct playlist imports from Spotify, YouTube Music, and Apple Music as alternate sources when a provider playlist is convenient. A saved Personal Text Playlist remains independent of those provider connections.

#### Spotify

MILO can use Spotify API credentials configured for the server:

```env
SPOTIPY_CLIENT_ID=
SPOTIPY_CLIENT_SECRET=
```

An administrator can provide global credentials, and an individual user can instead enter their own Spotify credentials in Sync Settings. The user's credentials take precedence for that user's sync.

#### Apple Music

The administrator can configure a global Apple Music Developer Token:

```env
APPLE_DEVELOPER_TOKEN=
```

An individual user can provide their own token in Sync Settings; their token takes precedence for their own sync.

#### YouTube Music

MILO accepts YouTube Music playlist links or IDs and does not require a separate YouTube API key in its current configuration. Imported playlist data is matched against the local catalog.

### Playlist Sync Options

Normally playlist synchronization is **additive**. Matching tracks that are not already in the user's library can be added; existing library selections are not removed simply because they are missing from the playlist being synced.

**One-for-One Playlist Mirror** is different. When enabled, the configured playlist defines which library selections remain, so tracks no longer represented by the playlist can be removed from that user's library. This changes the user's library references only; it does not delete the original audio from the master collection.

Before applying a manual import, MILO previews tracks to add, tracks already in the library, and unmatched entries. Review ambiguous matches instead of assuming all provider data will match local metadata exactly. **Auto Sync** and its schedule are configured per user in Sync Settings. Spotify and Apple Music credentials can be set globally by the administrator or supplied by individual users; a user's own credentials take precedence for that user's sync.

## Matching and Import Review

Playlist text and provider metadata do not always use the same artist, title, album, or version names found in local audio files. MILO normalizes imported information and uses fuzzy matching to find likely catalog entries, but uncertain matches should be reviewed rather than assumed correct.

Manual import preview separates tracks to add, tracks already in the library, and unmatched entries. Unmatched items can be handled through Unmatched Logs, while Organizer Review compares embedded metadata on files that may belong in the master pool. A plain-text list gives the user more control over the artist/title values being matched, but a match still depends on useful metadata in the local catalog.

## Unmatched Logs and Restore Tracks

**Unmatched Logs** keeps entries MILO could not confidently match. Users can review possible catalog matches, link an entry to a correct track where appropriate, or skip an entry to history for later review. Supported actions can be inspected and undone. A future successful sync can clear an unmatched entry once it is resolved.

**Restore Tracks** lets users recover previous library selections without having to search the entire catalog and manually rebuild the selection. Restoring a selection creates the library reference again; it does not restore or recreate a deleted source audio file.

## Music Organizer and Catalog Maintenance

MILO includes tools for maintaining the catalog as the master collection changes, as well as an organizer workflow for staging folders and files that need attention.

### Quick Scan

**Quick Scan** checks the master collection for new or changed files and attempts to reconcile moved or upgraded catalog paths. If the catalog is empty or uninitialized, MILO falls back to the detailed scan path rather than assuming it can safely update an empty catalog incrementally. The Quick Scan schedule is configured in Scan Settings.

### Detailed Full Scan

**Detailed Full Scan** performs a deeper recheck of the master collection, hashes files, refreshes catalog metadata and identity records, processes organizer staging folders, and reconciles moved or upgraded paths. Use it for initial catalog setup or when Quick Scan does not resolve a catalog issue. It can be run manually or scheduled separately in Scan Settings.

### Dead Files

**Dead Files** checks catalog entries whose recorded source paths can no longer be found. When a verified replacement is available, the administrator can repair the catalog to point to it. Clearing a dead entry removes the stale catalog record; it is not a command to delete unrelated source files.

### Organizer Review

Administrators can configure multiple Dump Folders - Staging locations, optional user assignment for a dump folder, exempt folders, the Trash folder, a MusicBrainz Picard-style naming script, and whether the script should rename the audio files themselves in **Scan Settings**. If renaming is disabled, the script still controls the destination folders while the original filename is retained.

**Organizer Review** is where uncertain files and potential conflicts can be handled rather than automatically overwritten. Depending on the item, review actions can include approving a valid metadata-incomplete candidate, handling possible matches or duplicates, keeping both files, upgrading or overwriting a target where supported, keeping the candidate in the dump folder, or staging a file in Trash. Comparisons use the files' embedded metadata, including title, artist/album artist, album, and duration where available; track or disc number by itself is not enough to identify a song. When enabled, scheduled scans can auto-approve new metadata-approval items only when their destination is valid and conflict-free. Manual scans and existing pending review items are not automatically approved.

Quick Scan and Detailed Full Scan have separate schedules. MILO coordinates maintenance and sync jobs rather than intentionally running several heavy jobs concurrently; a due Detailed Full Scan takes priority, followed by Quick Scan, then user sync jobs. The main progress panel reports running and completed background tasks. Progress can be restored after a browser refresh while the same server process is still running. In-flight filesystem work is not resumed automatically after a server restart.

## Administration

The administrator interface includes tools to:

* Manage user accounts and switch account roles between user and admin.
* Set each user's library path and Standard or Advanced linking mode.
* Configure Quick Scan and Detailed Full Scan schedules.
* Run scans and monitor progress.
* Review and repair Dead Files.
* Configure organizer folders, naming behavior, and review settings.
* Configure global Spotify and Apple Music credentials when desired.

### Initial Administrator Account

On the first startup, if the database does not already contain an administrator, MILO creates one with the following initial credentials:

```text
Username: admin
Password: admin
```

**Change the initial password immediately** and do not expose a fresh installation with the default credentials to an untrusted network.

## Requirements and Storage Safety

MILO needs a master music collection that the server can read, persistent writable application data, and a location where it can create user-library links. A source installation needs Node.js/npm compatible with the release and its project dependencies; a container installation needs Docker and Compose. If you use the Organizer, the server also needs appropriate access to the configured staging folders, master-pool destination, and Trash folder because organizing may move or rename audio files.

At minimum, the application needs permission to:

* Read audio files and their embedded metadata in the master collection.
* Read and write its database and related catalog/history records.
* Create user-library directories and create symbolic links in Standard Mode.
* Create hard links in Advanced Mode, when the filesystem layout supports them.
* Read and move staged audio files, create their planned destination folders, and rename files when the Organizer's rename option is enabled.
* Move duplicate or replaced versions into the configured Trash folder and, only after an explicit review action, delete a file that is physically inside that Trash folder.

### Important storage rules

* **Keep the master collection and application data persistent.** In Docker, mount `./data` to `/app/data`; this keeps the main database, sync history, and organizer history across container replacement and upgrades. Keep a separate backup of the databases before significant upgrades or bulk review operations.
* **Use container paths inside MILO.** Set `MASTER_POOL_DIR` and `LIBRARY_PATH` to paths as seen inside the container, and mount the corresponding host directories to those same locations. A host path such as `/mnt/music` is not automatically a valid in-container path unless it is mounted there.
* **Use a separate, deliberate Trash location.** Duplicates and replaced files may be staged there for review. Do not treat Trash as a backup, and do not permanently delete staged files until you have confirmed that the retained master-pool copy is correct.
* **Review Organizer changes before approving uncertain matches.** The Organizer can move or rename real source files as part of its configured workflow. Back up important files before the first run and check the naming script, staging folders, destination structure, and Trash path before enabling scheduled full scans.
* **Understand the difference between library removal and Organizer operations.** Removing a user's selection removes their symbolic/hard link, not the original master-pool audio. Organizer move, rename, replace, and explicit delete actions are separate filesystem operations.
* **Check hard-link compatibility before using Advanced Mode.** Source and destination must satisfy the operating system's hard-link rules and generally need to reside on the same filesystem/volume. Docker bind mounts, network shares, virtual filesystems, and separate volumes can prevent hard-link creation even if both paths appear inside the container.
* **Keep sensitive files private.** Protect the `.env` file, database files, SSL private key, and user-specific Text Playlist API keys. Change the initial administrator password and set a strong `FLASK_SECRET_KEY` before exposing the service beyond a trusted network.

Standard Mode is the recommended starting point unless your media application requires hard links or you have confirmed that your storage supports Advanced Mode. StableBit DrivePool users should also read the DrivePool section above; the physical-drive lookup does not remove hard-link filesystem requirements.

## Installation

MILO can run directly from source with Node.js/npm or be deployed using its Docker image. For release downloads, see [GitHub Releases](https://github.com/KenWeTech/MILO/releases); each release provides its source ZIP and release notes. The published container image is `ghcr.io/kenwetech/milo`.

### Run From Source

1. Download and extract the laatest ⁠`MILO-vX.X.X.zip`⁠ archive from [GitHub Releases](https://github.com/KenWeTech/MILO/releases).
2. Install the project dependencies from the project directory:

   ```bash
   npm install
   ```
3. Set the environment variables you need (see [Configuration](#configuration)).
4. Start the server:

   ```bash
   npm start
   ```

The default port is `8088`, and the server listens on `0.0.0.0`. On a network where mDNS works, you may also be able to access MILO at `http://milo.local:8088`.

### Docker Compose

The container needs persistent storage for its database, a mounted master music collection, and a persistent location for the administrator library and the base directory used by relative library paths. A starting `compose.yaml` is shown below:

```yaml
services:
  milo:
    image: ghcr.io/kenwetech/milo:latest
    container_name: milo
    restart: unless-stopped
    ports:
      - "8088:8088"
    env_file:
      - .env
    environment:
      PORT: 8088
      MASTER_POOL_DIR: /music
      LIBRARY_PATH: /app/MILO_Libraries
    volumes:
      # MILO database, sync history, and organizer history
      - ./data:/app/data
      # Library root used by the initial admin and relative user-library paths
      - ./MILO_Libraries:/app/MILO_Libraries
      # Your existing master music collection (write access is needed by the Organizer)
      - /path/to/your/music:/music
      # Persist certificates when using MILO's built-in HTTPS
      - ./ssl:/app/ssl
```

Replace `/path/to/your/music` with the host directory containing the master music collection. Keep `./data`, `./MILO_Libraries`, and (when using built-in HTTPS) `./ssl` in persistent host storage so application history, user-library links, and certificates survive container replacement or upgrades. Ensure the container user has enough permission to read the master music and create library links.

**How `LIBRARY_PATH` works:** In this example, the initial administrator's library path is `/app/MILO_Libraries`. `LIBRARY_PATH` also serves as the base for relative library paths for other accounts. For example, entering `alice` as a user's relative library path resolves to `/app/MILO_Libraries/alice`. An absolute library path is used as given, so it must also exist and be accessible inside the container. The library root must be a persistent mount; otherwise a container replacement can discard its directory structure.

Set a strong `FLASK_SECRET_KEY` in the `.env` file next to your Compose file. For example:

```env
FLASK_SECRET_KEY=replace-with-a-long-random-secret
SPOTIPY_CLIENT_ID=
SPOTIPY_CLIENT_SECRET=
APPLE_DEVELOPER_TOKEN=
DRIVEPOOL_DRIVES=
```

You do not need to set `DB_PATH` for the Compose example above; it defaults to the app's `data/milo.db` path, which is persisted by `./data:/app/data`. MILO also stores `sync_history.db` beside the configured main database, so keeping the database directory persistent preserves that history too.

When accessing MILO from the host, open `http://localhost:8088`. On another device, use the server's LAN address and port. `http://milo.local:8088` may work if mDNS announcements are available across your network and Docker setup.

#### DrivePool and Docker

The DrivePool physical-path lookup uses configured Windows drive letters and `PoolPart.*` folders. A typical Linux-based container cannot directly use host Windows drive letters such as `D:` or `E:`. Configure `DRIVEPOOL_DRIVES` only in a deployment where those paths are actually visible in the MILO process; do not copy Windows drive letters into a Linux container and expect the lookup to work. Hard links still need compatible physical storage and permissions.

## Configuration

MILO reads optional environment variables at startup. Only set the values needed for your deployment. In examples, forward slashes are used for paths; on Windows, forward-slash paths are accepted for absolute library paths as well.

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Port used by the web server | `8088` |
| `FLASK_SECRET_KEY` | Secret used to sign session cookies | Built-in development fallback; set your own |
| `DB_PATH` | Main SQLite database location | `data/milo.db` under the application directory |
| `MASTER_POOL_DIR` | Existing master music collection to index | `C:/Media/Music/MasterPool` |
| `LIBRARY_PATH` | Library root used for the initial admin library path and as the base for other users' relative library paths | Set explicitly for your deployment; the Docker example uses `/app/MILO_Libraries` |
| `SPOTIPY_CLIENT_ID` | Global Spotify API client ID | Not configured |
| `SPOTIPY_CLIENT_SECRET` | Global Spotify API client secret | Not configured |
| `APPLE_DEVELOPER_TOKEN` | Global Apple Music Developer Token | Not configured |
| `DRIVEPOOL_DRIVES` | Comma-separated physical DrivePool member drive letters, e.g. `D:,E:,F:` | Not configured |
| `USE_SSL` | Use MILO's built-in HTTPS server when set to `true` | `false` |
| `SSL_KEY_PATH` | Optional path to the HTTPS private key | `ssl/milo.key` under the application directory |
| `SSL_CERT_PATH` | Optional path to the HTTPS certificate | `ssl/milo.crt` under the application directory |

Set `LIBRARY_PATH` explicitly, especially in Docker, so the administrator's initial library and relative user-library paths resolve to a persistent location. The administrator's initial library path is set to this root; relative paths for other users are resolved beneath it. Absolute user-library paths are accepted too, but those locations must exist and be accessible to MILO.

Changing `LIBRARY_PATH` later does not automatically rewrite library paths already saved in the database. Review and update existing paths through **Manage Users** when moving an installation or changing the library layout.

Example `.env` values for the Docker layout above:

```env
FLASK_SECRET_KEY=replace-with-a-long-random-secret
MASTER_POOL_DIR=/music
LIBRARY_PATH=/app/MILO_Libraries
SPOTIPY_CLIENT_ID=
SPOTIPY_CLIENT_SECRET=
APPLE_DEVELOPER_TOKEN=
DRIVEPOOL_DRIVES=
```

For Docker, use the container paths from the Compose example. For a source installation, set `MASTER_POOL_DIR` and `LIBRARY_PATH` to real paths on the host instead; `/music` and `/app/MILO_Libraries` are specific to the example container layout.

## SSL Configuration and PWA Support

MILO can serve HTTPS itself or run behind a reverse proxy. Use one method at a time. The PWA's service worker and offline behavior require a secure, trusted browser origin; clicking through a certificate warning alone is not enough on many browsers.

### Reverse Proxy (Recommended for HTTPS)

If you use Caddy, Traefik, Nginx Proxy Manager, or another reverse proxy, leave `USE_SSL` unset or set it to `false`. The proxy should handle HTTPS and present a certificate trusted by the devices that access MILO. Connect the proxy to MILO over its internal HTTP port. In this setup, MILO does not need to serve its own SSL certificate.

### MILO's Built-In HTTPS

For direct HTTPS access, set:

```env
USE_SSL=true
```

MILO looks for the key at `ssl/milo.key` and the certificate at `ssl/milo.crt` by default. You can change their locations with `SSL_KEY_PATH` and `SSL_CERT_PATH`. If either file is missing, MILO attempts to generate a self-signed certificate. If certificate generation fails, MILO logs the problem and starts in HTTP mode instead.

#### Docker Built-In HTTPS: Keep and Use the Generated Files

The Compose example mounts `./ssl:/app/ssl`. Keep this mount if you want the generated files to survive container replacement. With `USE_SSL=true`, start MILO once; the first startup creates the certificate files in the host's `./ssl` directory when they do not already exist:

```text
./ssl/milo.crt   # certificate to install/trust on client devices
./ssl/milo.key   # private key; keep this on the server and never distribute it
```

Then access MILO over HTTPS using the hostname covered by the certificate. The auto-generated certificate is created for `milo.local`, so start by testing `https://milo.local:8088`. Avoid the raw IP address unless the certificate was issued for that IP address. If the browser reports a hostname mismatch, use a certificate containing the exact hostname in its Subject Alternative Name (SAN), or use a trusted reverse proxy; trusting a certificate does not correct a hostname mismatch.

#### Trust the Certificate So the PWA Works

A self-signed certificate encrypts the connection but is not automatically trusted by other devices. Copy **only `milo.crt`** from the server's `ssl` folder to each phone, tablet, or computer that will use MILO, then install it as a trusted certificate/authority using that device's certificate or security settings. For example:

* **Windows:** import `milo.crt` into the appropriate Trusted Root Certification Authorities store.
* **macOS:** import it into Keychain Access, open the certificate's trust settings, and set it to Always Trust for the intended use.
* **iPhone/iPad:** install the certificate profile, then enable full trust for it under **Settings → General → About → Certificate Trust Settings**.
* **Android:** use the device's **Security / Encryption & credentials** settings to install the certificate; wording and support vary by Android version and device manufacturer.

After trusting the certificate, reopen the exact HTTPS hostname in the browser and confirm it no longer reports an untrusted connection before installing or using the PWA. Browsers may still reject a self-signed certificate that lacks the correct hostname/SAN, even if the certificate is installed. For the most predictable PWA experience, use a trusted certificate whose SAN matches the address users will open.

Keep `milo.key` private. Do not upload it to client devices or share it with users. The `.crt` file is the public certificate; the `.key` file authorizes the server to present it.

## Security Considerations

MILO is intended for self-hosted environments. Before exposing it outside a trusted network:

* Change the default administrator password.
* Set a strong `FLASK_SECRET_KEY`; do not use the built-in fallback for a deployment you care about.
* Use appropriate firewall and network controls, especially if the server is reachable outside your home or organization.
* Grant MILO only the filesystem permissions it needs to read the music and manage the configured library directories.
* Keep the database, `.env` file, SSL private key, and user-specific Text Playlist API keys protected.
* Be careful when giving organizer features write access to staging, master-pool, and Trash locations.

Removing a track from a user's library is intended to remove the user's link, not the original music from the master collection. Organizer and catalog-maintenance actions are separate from library selection; review file-operation prompts and destinations carefully before applying them.

## Current Limitations

Keep these limitations in mind:

* Spotify's webpage/scraping fallback can be limited to around 200 tracks.
* Direct playlist imports from Spotify, YouTube Music, and Apple Music depend on data exposed by the external services. Changes to a provider's website, API, access rules, or response format can make an import incomplete or cause it to stop working. The saved Personal Text Playlist is not dependent on those provider connections, although matching its artist/title entries still depends on the local catalog metadata.
* Artist, title, album, and version values from a playlist may not match embedded tags exactly. Fuzzy matching can fail or suggest an imperfect match, so review ambiguous or unmatched entries.
* Standard Mode depends on the media application's handling of symbolic links. Advanced Mode depends on hard-link support and compatible filesystem/volume layout.
* StableBit DrivePool lookup requires the configured physical drive paths and matching `PoolPart.*` files to be available to the MILO process.
* Docker deployments require correct volume mappings and filesystem permissions. mDNS discovery of `milo.local` may not work through every router, VLAN, or Docker network.
* Background work can be tracked after refreshing the page while the same server process is running, but in-flight jobs are not resumed automatically after the server is restarted.

See [GitHub Issues](https://github.com/KenWeTech/MILO/issues) for known problems and [GitHub Releases](https://github.com/KenWeTech/MILO/releases) for the source ZIP, and release notes. See [Github Packages](https://github.com/KenWeTech/MILO/pkgs/container/milo) for available Docker images.
