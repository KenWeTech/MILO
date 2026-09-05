Sharing a project I use locally that I think might help others. Currently working on a docker image, so will upload everything soon. For now:

# MILO - Music Index & Library Organizer

MILO is a self-hosted music catalog and library organization server that manages access to a master music collection without duplicating audio files.

## Overview

MILO sits between a master music collection and individual user libraries, creating user-specific directory structures using symbolic links or hard links. This allows multiple users to maintain unique libraries from a single shared collection.

## Why MILO?

Traditional music servers generally focus on playing a collection, whereas MILO focuses on organizing access to it. The goal is to make one large music collection usable by multiple people who may each want a different subset of that collection. Instead of forcing everyone to use the same library or misusing Favorites as a makeshift second library, MILO provides a catalog and selection layer that maintains individual user libraries via filesystem links without requiring another physical copy of every audio file.
