<p align="center">
  <img src="https://github.com/KenWeTech/MILO/blob/main/MILO/public/logo.png?raw=true" alt="MILO Logo" width="300"/>
</p>

# **MILO — Music Index & Library Organizer**

MILO is a self-hosted music catalog and library organization server. It presents an existing music collection as a browsable index, allowing authenticated users to build and manage their own personal music libraries without duplicating the underlying audio files.

## What MILO Does

MILO sits between a master music collection and the individual libraries created from it:

```text
┌──────────────────────────┐
│  Master Music Collection │
│    Original Files        │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│     MILO Music Index     │
│  Browse • Search • View  │
└────────────┬─────────────┘
             │
       User selection
       or playlist sync
             │
             ▼
┌──────────────────────────┐
│    User's MILO Library   │
│  Selected tracks/albums  │
│     represented by       │
│   Plex/Navidrome/etc.    │
└──────────────────────────┘
```

Rather than making a complete copy of the music collection for every user, MILO creates user-specific library structures using **symbolic links** to the original files.

This makes it possible for multiple users to have different libraries while the server maintains a single underlying music collection. There is no need to increase storage simply because multiple people want separate libraries. Favorite the songs you like because you can, without wasting storage as a workaround for separating libraries.

## Core Features

* **Music catalog** — Browse an indexed view of the available music.
* **Track selection** — Add individual tracks to a personal library.
* **Library management** — View and remove tracks from a user's library.
* **Playlist synchronization** — Use playlists as a convenient way to select groups of tracks.
* **Automatic playlist synchronization** — Enable Auto Sync to automatically process a configured playlist on the schedule established by the administrator.
* **Per-user libraries** — Each account can maintain its own selection.
* **Symlink-based libraries** — User libraries reference the original files instead of duplicating them.
* **Advanced linking mode** — Use hard links where supported for applications that require them.
* **Non-destructive removal** — Removing a track from a user library removes its library reference; it does not delete the original music file.
* **Fuzzy playlist matching** — Imported playlist information is matched against the local music catalog.
* **Failed match tracking** — Tracks that cannot be confidently matched are recorded for review.
* **Multiple playlist sources** — Import playlists from Spotify, YouTube Music, Apple Music, or plain text.
* **Self-hosted** — MILO is designed to run against a music collection you control.

## Why MILO?

Traditional music servers generally focus on **playing** a collection as a whole. You should not have to waste your storage or alter your favorite music tags simply to separate your music into different libraries.

Many people end up using a music server's **Favorites** feature as a workaround for this problem: they favorite the songs they want, then configure the server to show or expose only those favorites. Favorites are useful for marking music you actually want to favorite. They should not have to become a substitute for having a separate library.

MILO focuses on **organizing access to a collection**.

The goal is to make one large music collection usable by multiple people who may each want a different subset of that collection. MILO provides the catalog and selection layer, then maintains those individual libraries without requiring another physical copy of every audio file.

This means users can choose the music they actually want in their own library without everyone being forced to use the same library or resorting to Favorites as a library-separation workaround.

### One collection. Many libraries. No unnecessary duplication.

## How It Works

### 1. Index the master collection

MILO scans and indexes the configured music collection so it can be presented as a searchable, browsable catalog.

The catalog stores the information needed to identify and match the music while the original files remain in the master collection.

### 2. Browse the catalog

Users sign in and browse the music available from the master collection.

Tracks can be searched, sorted, filtered, and viewed through the catalog.

### 3. Select music

A user can select individual tracks or use a playlist to select multiple tracks at once.

Individual tracks can be added or removed directly from the catalog.

### 4. Build the personal library

MILO creates the user's library structure using filesystem links that point back to the original files.

Standard Mode uses symbolic links.

Advanced Mode uses hard links when the storage and filesystem support them.

### 5. Manage the library

Users can add additional tracks, synchronize playlists, review failed matches, or remove selections as their library changes.

**Synchronizing a playlist does not remove tracks from the user's existing library.**

A playlist sync is used to find and add tracks from the playlist that match the local catalog. Tracks the user already has remain in the library, even if they are not present in the playlist being synchronized.

Removing a selection from a user's library does **not** remove the source file from the master collection.

The exception is **One-for-One Sync**, which can be enabled when a user specifically wants their library to follow the contents of a configured playlist. One-for-One Sync is an explicit library-management option and is separate from normal additive playlist synchronization.

## Library Linking Modes

MILO supports two ways of representing files in user libraries.

### Standard Mode

Standard Mode uses **symbolic links**.

```text
Master Collection
      │
      └── Artist/Album/Track.flac
                    ▲
                    │ symbolic link
                    │
User Library
      └── Artist/Album/Track.flac
```

The user library contains links pointing to the original files in the master collection rather than copies of those files.

This is the default and generally recommended mode.

### Advanced Mode

Advanced Mode uses **hard links** instead of symbolic links.

Hard links reference the same underlying file data without creating another physical copy of the music.

Hard links have stricter filesystem requirements than symbolic links. The relevant files must be on storage that supports hard links, and the source and destination must be on the same filesystem/physical volume where required.

Advanced Mode is particularly useful when another application does not properly recognize symbolic-link-based libraries.

### Plex and Advanced Mode

If you intend to use the libraries created by MILO with **Plex**, you may need to use **Advanced Mode**.

Depending on the Plex installation and how the library path is mounted, Plex may not properly discover or display music represented by symbolic links. Using hard links can allow Plex to see the files as normal filesystem files while still avoiding duplicate storage.

If Plex does not show a MILO-generated library correctly while using Standard Mode, Advanced Mode is the first option to try, provided the underlying storage supports hard links.

Other music and media applications may have different behavior when handling symbolic links.

### Which mode should I use?

Use **Standard Mode** unless you have a reason to require hard links.

Use **Advanced Mode** when:

* Your media application does not properly follow symbolic links.
* Plex does not properly discover the generated library.
* You need the files represented as hard-linked filesystem entries.
* Your storage configuration supports hard links.

## StableBit DrivePool Support

MILO includes support for installations using **StableBit DrivePool**.

When configured, MILO can locate the physical `PoolPart.*` storage containing a source file.

This allows Advanced Mode to attempt the hard link against the underlying physical storage rather than the DrivePool virtual filesystem.

Configure the physical DrivePool member drives using:

```env
DRIVEPOOL_DRIVES=D:,E:,F:
```

Multiple drives can be provided as a comma-separated list.

Advanced Mode still requires the underlying filesystem to support hard links. If the physical volume does not support them, Standard Mode should be used instead.

## Playlists

Playlists provide a convenient way to select many tracks without manually adding each track from the catalog.

MILO supports:

* Plain text lists
* Spotify playlists
* YouTube Music playlists
* Apple Music playlists

A playlist can be processed manually whenever the user wants to update their library.

Playlist synchronization is **additive** by default. Tracks already in the user's library are not removed simply because they are absent from the playlist.

### One-for-One Sync

MILO also provides an optional **One-for-One Sync** mode.

One-for-One Sync is intended for users who want a configured playlist to represent the contents of their library rather than simply use the playlist as an additional source of tracks.

When One-for-One Sync is enabled, tracks matched from the playlist are kept and tracks that are no longer represented by the playlist can be removed from the user's MILO library.

This behavior is intentionally different from normal playlist synchronization.

One-for-One Sync only changes the user's library references. It does **not** delete the corresponding source music from the master collection.

If One-for-One Sync is not enabled, playlist synchronization remains additive and existing library selections are retained.

## Automatic Sync

MILO includes an **Auto Sync** option in the user's Sync Settings.

When enabled, the user configures the playlist they want MILO to synchronize.

The administrator controls the server-wide schedule for automatic synchronization.

When the scheduled sync runs, MILO automatically processes the user's configured playlist and submits the resulting matches for the user's library.

Auto Sync is useful for playlists that change regularly. Instead of manually importing the playlist every time it changes, MILO can periodically check the configured playlist and add newly matching tracks to the user's library.

Auto Sync does **not** turn the user's library into an exact copy of the playlist unless **One-for-One Sync** is explicitly enabled.

With normal Auto Sync, tracks already in the user's library are not removed when they disappear from the playlist.

When One-for-One Sync is enabled, Auto Sync can remove library selections that are no longer represented by the configured playlist.

As with all MILO library removal operations, removing a library reference does not delete the original music file from the master collection.

## Plain Text Playlists - Recommended

MILO can accept a plain text list containing one track per line.

For example:

```text
Daft Punk - One More Time
The Weeknd - Blinding Lights
Gorillaz - Feel Good Inc.
```

This can be useful even when the original music service is not directly supported by MILO.

Services such as **TuneMyMusic** can be used to convert playlists between music services or export playlist information into a text-based format that can then be supplied to MILO.

This also provides another option when a particular service's playlist information does not match the way the music is represented in the local catalog.

In some cases, a text export may actually produce better matches than importing the playlist directly from a provider because the provider's playlist metadata can be formatted differently from the artist/title information stored in the local music collection.

## Spotify

Spotify playlist importing supports two approaches.

### Spotify API

MILO can use Spotify API credentials to retrieve playlist tracks directly.

Configure global credentials using:

```env
SPOTIPY_CLIENT_ID=
SPOTIPY_CLIENT_SECRET=
```

When configured, MILO can use the Spotify API rather than relying on Spotify web-page scraping.

**Spotify API credentials are highly recommended** if you intend to regularly use Spotify playlist synchronization.

### Per-User Spotify Credentials

The administrator can configure Spotify API credentials globally for the MILO server.

Individual users can also provide their **own Spotify API credentials** through their Sync Settings.

This is useful when:

* The administrator does not have Spotify API credentials configured.
* The administrator does not want to provide global credentials.
* A user wants to use their own Spotify developer application.
* A user needs or prefers to use credentials associated with their own Spotify developer account.

When a user has supplied their own Spotify credentials, those credentials take precedence for that user's Spotify playlist synchronization.

Global administrator-configured credentials remain available for users who do not provide their own.

### Spotify Scraping — Fallback

When API credentials are not configured, MILO can attempt to retrieve playlist information through Spotify's web data.

This scraping functionality is **not 100% reliable** may limit around 200 results.

Spotify can change its website, embedded data, or other implementation details without notice. Such changes can cause scraping to stop working, return incomplete information, or behave differently from the official API.

The scraper is therefore provided as a fallback and is **not intended to replace the official Spotify API**.

If Spotify playlist synchronization is important to your setup, configuring the Spotify API credentials is strongly recommended.

## Apple Music

Apple Music playlist importing also supports two approaches.

### Apple Music API

MILO can use an Apple Music Developer Token to retrieve playlist tracks through Apple's Music API.

Configure the global token using:

```env
APPLE_DEVELOPER_TOKEN=
```

When the token is available, MILO uses the Apple Music API.

**An Apple Music Developer Token is highly recommended** if you intend to regularly use Apple Music playlist synchronization.

### Per-User Apple Music Credentials

The administrator can configure an Apple Music Developer Token globally for the MILO server.

Individual users can also provide their **own Apple Music Developer Token** through their Sync Settings.

This is useful when:

* The administrator does not have an Apple Music Developer Token configured.
* The administrator does not want to provide a global token.
* A user wants to use their own Apple developer credentials.
* A user needs or prefers to use a token associated with their own Apple developer account.

When a user has supplied their own Apple Music Developer Token, that token takes precedence for that user's Apple Music playlist synchronization.

The global administrator-configured token remains available for users who do not provide their own.

### Apple Music Scraping — Fallback

When an Apple Music Developer Token is not configured, MILO can attempt to extract playlist information from Apple Music's web pages.

Like the Spotify scraper, this functionality is **not 100% reliable**.

Changes to Apple's website or the data embedded within its pages can cause the scraper to stop working or return incomplete playlist information.

The scraper is a fallback option, not a replacement for the official Apple Music API.

## YouTube Music

MILO can import YouTube Music playlists through its current YouTube integration.

No YouTube API credential is currently required by MILO for this provider.

Playlist information is extracted and then matched against the local music catalog.

YouTube Music playlist data can sometimes differ from the artist/title information stored in a local music collection. If direct playlist importing does not produce the desired matches, exporting or converting the playlist to plain text and importing the text is another option.

## Fuzzy Matching

Playlist services and local music collections do not always use identical naming.

For example:

```text
Playlist:
The Weeknd - Blinding Lights

Catalog:
Blinding Lights
Artist: The Weeknd
```

MILO normalizes the imported information and uses fuzzy matching to locate the closest catalog entry.

Matches that meet the current confidence threshold are treated as successful matches.

Tracks that do not reach the required confidence are treated as failed matches rather than being silently added to the wrong track.

## Match Failures

When MILO cannot confidently match a playlist track, it records information about the failed match.

This allows failed imports to be reviewed rather than silently disappearing.

The failed-track interface can also provide possible matches from the local catalog, allowing the user to select the correct track when an appropriate match exists.

## Import Review

Playlist imports provide a review of the synchronization results.

### Tracks to Add

Tracks that matched the catalog and are not currently in the user's library.

### Already in Library

Tracks that successfully matched but are already part of the user's library.

These tracks are left alone.

### Match Failures

Tracks that could not be confidently matched to the catalog.

This allows the user to review what MILO found before adding the new selections.

## Symlink Architecture

The important distinction in MILO is between the **source collection** and a **user library**.

For example:

```text
/music
├── Artists
│   ├── Artist A
│   │   └── Album
│   │       └── Track 01.flac
│   └── Artist B
│       └── Album
│           └── Track 02.flac

/milo-libraries
├── alice
│   └── Artist A
│       └── Album
│           └── Track 01.flac -> /music/Artists/Artist A/Album/Track 01.flac
│
└── bob
    └── Artist B
        └── Album
            └── Track 02.flac -> /music/Artists/Artist B/Album/Track 02.flac
```

The same source file can therefore be represented in multiple user libraries without being copied multiple times.

The resulting libraries can be used by compatible software such as Plex, Navidrome, or other applications that can work with the resulting filesystem structure.

MILO itself is responsible for organizing the library, not playing the music.

## Data Safety

MILO's user-library operations are designed around references to the master collection.

In particular:

> Removing music from a user's MILO library must not delete the original music from the master collection.

The source collection remains the authoritative location for the actual audio files.

Removing a track from a user's library removes the user's selection and its corresponding library reference.

It does not intentionally remove the source file.

One-for-One Sync follows the same rule: even when a track is removed from a user's library because it is no longer present in the configured playlist, the original source file remains untouched.

## Administration

MILO includes an administrator interface for maintaining the catalog and managing users.

Administrators can:

* Manage user accounts.
* Configure user library paths.
* Select the user's linking mode.
* Rescan the master music collection.
* Scan for catalog entries whose source files no longer exist.
* Remove dead catalog entries.
* Configure the server-wide Auto Sync schedule.

### Initial Administrator Account

On the first startup, if no administrator exists, MILO creates an administrator account with:

```text
Username: admin
Password: admin
```

**Change or secure this account before exposing MILO to an untrusted network.**

The administrator library path can be configured using:

```env
ADMIN_LIBRARY_PATH=
```

If it is not configured, the initial administrator library currently defaults to `Admin_Library` in the application's working directory.

## Requirements

MILO requires:

* A music collection accessible to the server.
* A filesystem that supports symbolic links.
* A location where MILO can create individual user library structures.
* Appropriate filesystem permissions for the application.
* User authentication for access to personal libraries.

For Advanced Mode:

* The underlying filesystem must support hard links.
* The source and destination must satisfy the filesystem's hard-link requirements.
* StableBit DrivePool installations using Advanced Mode may require `DRIVEPOOL_DRIVES` to be configured.

For Docker:

* The master music collection must be mounted into the container.
* User library locations must be mounted into the container.
* The database should be stored in persistent storage.
* The container must have the permissions required to read the master collection and create the selected type of filesystem links.

## Installation

MILO can be run directly from source with Node.js/npm or deployed using the provided Docker image.

### Run From Source

Install the project's dependencies and start MILO with:

```bash
npm start
```

The server listens on:

```text
http://0.0.0.0:8088
```

### Docker

MILO is also distributed as a Docker image for users who prefer containerized deployment.

The container needs access to the same resources as a source installation:

```text
┌─────────────────────────┐
│       Host Storage      │
│                         │
│  Master Music Collection│
│  User Library Directory │
│  MILO Database          │
└────────────┬────────────┘
             │ mounted
             ▼
┌─────────────────────────┐
│       MILO Container    │
│                         │
│  Catalog                │
│  User Management        │
│  Playlist Sync          │
│  Library Linking        │
└─────────────────────────┘
```

A Docker deployment should mount the following locations:

* `/app/data` — MILO database and application data
* `/userdir` — directory where MILO creates and manages user libraries
* `/music` — master music collection

For example:

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

    volumes:
      # MILO database and application data
      - ./data:/app/data

      # User libraries created/managed by MILO
      - /path/to/user/dir:/userdir

      # Master music collection
      - /path/to/your/music:/music

    environment:
      MASTER_POOL_DIR: /music
```

Replace `/path/to/user/dir` with the host directory where you want MILO to create and manage user libraries. Replace `/path/to/your/music` with the location of your master music collection.

The host directory mapped to `/userdir` can be located wherever you store your MILO user libraries. MILO uses `/userdir` internally, so the host path does not need to match that name.

The `./data:/app/data` mount keeps MILO's SQLite database and application data on persistent storage. This prevents the database from being lost when the container is recreated or updated.

If using Advanced Mode, pay particular attention to how the host storage is mounted into the container. Hard links cannot cross filesystems, and container volume mappings can change how those filesystems appear from inside the container. The master collection and user-library storage must be accessible from compatible filesystems for hard linking to work correctly.

## Configuration

MILO uses environment variables for server configuration.

Current configuration values include:

| Variable                | Purpose                                                | Default                                              |
| ----------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `FLASK_SECRET_KEY`      | Session secret used by the application                 | `change-this-to-a-random-secret`                     |
| `DB_PATH`               | SQLite database location                               | `data/milo.db`                                       |
| `MASTER_POOL_DIR`       | Master music collection location                       | `C:\Media\Music\MasterPool`                          |
| `ADMIN_LIBRARY_PATH`    | Initial administrator library location                 | `Admin_Library` in the application working directory |
| `SPOTIPY_CLIENT_ID`     | Global Spotify API client ID                           | Not configured                                       |
| `SPOTIPY_CLIENT_SECRET` | Global Spotify API client secret                       | Not configured                                       |
| `APPLE_DEVELOPER_TOKEN` | Global Apple Music API Developer Token                 | Not configured                                       |
| `DRIVEPOOL_DRIVES`      | Physical DrivePool drives to inspect for Advanced Mode | Not configured                                       |

Spotify and Apple Music credentials can also be supplied by individual users through their Sync Settings. User-provided credentials take precedence over the corresponding global credentials for that user.

### Example

```env
FLASK_SECRET_KEY=change-this-to-a-random-secret
DB_PATH=data/milo.db

MASTER_POOL_DIR=/music

ADMIN_LIBRARY_PATH=/libraries/admin

SPOTIPY_CLIENT_ID=
SPOTIPY_CLIENT_SECRET=

APPLE_DEVELOPER_TOKEN=

DRIVEPOOL_DRIVES=
```

Paths should be changed to match the filesystem layout of the host or container.

## Important Configuration Notes

### Session Secret

Do not use the built-in default session secret for a production deployment.

Set:

```env
FLASK_SECRET_KEY=
```

to a strong random value.

### Master Music Collection

The master collection must be accessible to the MILO process.

Set:

```env
MASTER_POOL_DIR=
```

to the location containing the original music.

MILO recursively scans this directory when an administrator performs a master-pool scan.

### User Library Paths

Each user has their own library path.

These paths determine where MILO creates the user's filesystem library.

For Docker installations, the library path entered in the MILO user-management interface **must start with `/userdir/`**.

For example:

```text
/userdir/alice
/userdir/bob
/userdir/charlie
```

The `/userdir/` path refers to the directory mapped into the container through the Docker volume configuration. Do not enter the host filesystem path in the MILO interface.

For example, with:

```yaml
volumes:
  - /mnt/storage/milo-users:/userdir
```

the library path entered in MILO should be:

```text
/userdir/alice
```

not:

```text
/mnt/storage/milo-users/alice
```

This is important for Docker deployments because MILO operates on the filesystem as it appears **inside the container**. Using the host-side path in the MILO interface can cause library creation and linking operations to fail.

For non-Docker installations, use the actual filesystem path accessible to the MILO server.

The library contains links to the master collection rather than independent copies of the audio files.

### Database

MILO currently uses SQLite.

The database stores information including:

* Users
* Catalog entries
* User track selections
* Playlist synchronization settings
* Unmatched-track logs

Keep the database file persistent when running MILO in Docker.

## Storage & Permissions

MILO needs filesystem access appropriate to the operations being performed.

At minimum, the application needs to be able to:

* Read the master music collection.
* Read music metadata.
* Create user library directories.
* Create symbolic links in Standard Mode.
* Create hard links in Advanced Mode.

When using Docker, filesystem permissions are especially important.

A container that can read the music collection but cannot create links in the target library location will not be able to build user libraries correctly.

Advanced Mode has additional filesystem restrictions and should only be enabled when the storage layout is known to support hard links.

## Catalog Maintenance

The catalog is a database-backed index of the master music collection.

When the master collection changes, an administrator can use **Rescan Master Pool** to update the catalog.

MILO also provides a **Dead Files** check.

Dead catalog entries are catalog records whose source files can no longer be found at their stored paths.

Administrators can review these entries before removing them from the database.

The dead-file cleanup process is intended to clean up stale catalog records without deleting the original music files that still exist.

## Security Considerations

MILO is intended for self-hosted environments.

Before exposing the application outside a trusted network:

* Change the default administrator password.
* Set a strong `FLASK_SECRET_KEY`.
* Protect the application with appropriate network controls.
* Ensure the application has only the filesystem permissions it actually needs.
* Keep the database and configuration files protected.
* Be careful when granting MILO write access to music-library locations.

MILO is designed so that removing a user's library selection does not intentionally delete the underlying source music.

## What MILO Is Not

MILO is **not intended to be a music player**.

It is the catalog and library organization layer around an existing music collection.

It does not replace the software you already use to play your music.

Instead, MILO makes it easier to create and maintain the particular library you want from a larger collection.

The resulting user libraries can then be used by compatible music-server or media-management software.

## Current Limitations

MILO is under active development.

In particular:

* Spotify web scraping is not guaranteed to remain reliable, may limit around 200 results.
* Apple Music web scraping is not guaranteed to remain reliable.
* Plain Text Playlists converted from **TuneMyMusic** is highly recommended right now for all music services to prevent errors or missing tracks.
* Playlist matching is based on metadata and fuzzy matching, so incorrect, incomplete, or ambiguous metadata can result in failed or imperfect matches.
* YouTube Music playlist information may sometimes produce different or less useful matching data than a plain-text playlist export.
* Advanced Mode depends on filesystem support for hard links.
* Plex and other media applications may handle symbolic links differently; Plex may require Advanced Mode for MILO-generated libraries to be discovered correctly.
* Docker deployments require correct volume mappings and filesystem permissions, particularly when using Advanced Mode.
* Playlist provider integrations and scraping behavior may change as external services change their websites or APIs.

The scraping implementations are fallback functionality and should not be considered equivalent in reliability to the official APIs.
