// SPDX-FileCopyrightText: 2026 MoeWah
// SPDX-License-Identifier: AGPL-3.0-only

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as plugin from "./index.js";

const settings = { server: "http://emby.test:8096/", username: "alice", password: "secret" };
const storage = new Map();
const calls = [];

globalThis.host = {
  platform: "darwin",
  arch: "arm64",
  t: (text) => text,
  language: () => "en",
  setting: (key) => settings[key],
  storage: {
    get: (key) => storage.get(key),
    set: (key, value) => storage.set(key, value),
    remove: (key) => storage.delete(key),
  },
  crypto: { md5: (text) => createHash("md5").update(text).digest("hex") },
};

let handler = () => ({ status: 200, body: {} });

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  calls.push({ url, options });
  return reply(await handler(url, options));
};

function reply({ status = 200, body = null, text = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
    text: async () => (text !== null ? text : body === null ? "" : JSON.stringify(body)),
  };
}

function signedIn() {
  storage.set("token", "tok");
  storage.set("userId", "u1");
  storage.set("userName", "Alice");
}

function albumImage(id, tag) {
  return `http://emby.test:8096/emby/Items/${id}/Images/Primary?maxWidth=%7Bsize%7D&maxHeight=%7Bsize%7D${tag ? `&tag=${tag}` : ""}`;
}

function userImage(id, tag) {
  return `http://emby.test:8096/emby/Users/${id}/Images/Primary?maxWidth=%7Bsize%7D&maxHeight=%7Bsize%7D${tag ? `&tag=${tag}` : ""}`;
}

// freeze pins the plugin's clock to a local hour, so a mix's slot is known.
function freeze(hour, minute = 0) {
  const date = new Date(2026, 10, 13, hour, minute);
  globalThis.host.now = () => date.getTime();
}

// mixItem is a song shaped for the daily mix's pools.
function mixItem(id, artist, album = `album-${id}`, cover = false) {
  return {
    Id: id,
    Name: id,
    AlbumId: album,
    Album: album,
    ArtistItems: [{ Id: artist, Name: artist }],
    RunTimeTicks: 10000000,
    ...(cover ? { AlbumPrimaryImageTag: `tag-${id}` } : {}),
  };
}

// dailySource answers the daily mix's queries from the pools it's given.
function dailySource({ top = [], favorites = [], mix = [], recent = [], random = [] }) {
  return (url) => {
    if (url.pathname === "/emby/Items/seed1/InstantMix") return { status: 200, body: { Items: mix } };
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    const params = url.searchParams;
    if (params.get("IncludeItemTypes") === "Audio") {
      if (params.get("Filters") === "IsPlayed") return { status: 200, body: { Items: top } };
      if (params.get("Filters") === "IsFavorite") return { status: 200, body: { Items: favorites } };
      if (params.get("Filters") === "IsUnplayed" && params.get("SortBy") === "PremiereDate") {
        return { status: 200, body: { Items: recent } };
      }
      if (params.get("Filters") === "IsUnplayed") return { status: 200, body: { Items: random } };
    }
    if (params.get("IncludeItemTypes") === "MusicAlbum" && params.get("Filters") === "IsFavorite") {
      return { status: 200, body: { Items: [{ Id: "seed1" }] } };
    }
    return { status: 200, body: { Items: [] } };
  };
}

beforeEach(() => {
  calls.length = 0;
  storage.clear();
  settings.server = "http://emby.test:8096/";
  settings.username = "alice";
  settings.password = "secret";
  delete settings.apiKey;
  delete globalThis.host.now;
  handler = () => ({ status: 200, body: {} });
});

test("signing in with a password keeps the token and answers the account", async () => {
  handler = (url, options) => {
    if (url.pathname !== "/emby/Users/AuthenticateByName") return { status: 404, body: {} };
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { Username: "alice", Pw: "secret" });
    assert.match(options.headers["X-Emby-Authorization"], /^MediaBrowser Client="MyGo Music"/);
    return {
      status: 200,
      body: {
        AccessToken: "tok",
        ServerId: "srv",
        User: { Id: "u1", Name: "Alice", ImageTags: { Primary: "utag" } },
      },
    };
  };

  const account = await plugin.signIn();
  assert.equal(account.id, "u1");
  assert.equal(account.name, "Alice");
  assert.equal(account.page, "profile");
  assert.equal(account.imageUrl, userImage("u1", "utag"));
  assert.equal(storage.get("token"), "tok");
  assert.equal(storage.get("userId"), "u1");
  assert.equal(plugin.account().id, "u1");
});

test("signing in with an API key finds the user behind it", async () => {
  settings.apiKey = "key-1";
  delete settings.username;
  delete settings.password;
  handler = (url, options) => {
    assert.equal(url.pathname, "/emby/Users/Me");
    assert.equal(options.headers["X-Emby-Token"], "key-1");
    return { status: 200, body: { Id: "u2", Name: "Bob" } };
  };

  const account = await plugin.signIn();
  assert.equal(account.id, "u2");
  assert.equal(account.name, "Bob");
  assert.equal(storage.get("token"), "key-1");
});

test("changing the server forgets the session", () => {
  signedIn();
  storage.set("slotPlays", "{}");
  plugin.setSetting({ key: "server", value: "http://elsewhere" });
  assert.equal(plugin.account(), null);
  assert.equal(storage.has("token"), false);
  assert.equal(storage.has("slotPlays"), false);
});

test("search maps items and carries the page offset", async () => {
  signedIn();
  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    assert.equal(url.searchParams.get("IncludeItemTypes"), "Audio");
    assert.equal(url.searchParams.get("SearchTerm"), "hello");
    assert.equal(url.searchParams.get("StartIndex"), "50");
    assert.equal(url.searchParams.get("Limit"), "50");
    return {
      status: 200,
      body: {
        TotalRecordCount: 101,
        Items: [
          {
            Id: "t1",
            Name: "Song",
            RunTimeTicks: 1800000000,
            AlbumId: "al1",
            Album: "Album",
            AlbumPrimaryImageTag: "atag",
            ArtistItems: [{ Id: "ar1", Name: "Artist" }],
            AlbumArtists: [{ Id: "ar1", Name: "Artist" }],
            PremiereDate: "2020-05-01T00:00:00.0000000Z",
            Container: "flac",
          },
        ],
      },
    };
  };

  const result = await plugin.search({ query: "hello", kind: "tracks", offset: 50 });
  assert.equal(result.more, true);
  assert.equal(result.tracks.length, 1);
  const track = result.tracks[0];
  assert.equal(track.id, "t1");
  assert.equal(track.name, "Song");
  assert.equal(track.duration, 180000);
  assert.deepEqual(track.artists, [{ id: "ar1", name: "Artist" }]);
  assert.equal(track.album.id, "al1");
  assert.equal(track.album.name, "Album");
  assert.equal(track.album.imageUrl, albumImage("al1", "atag"));
  assert.equal(track.album.released, "2020-05-01");
  assert.equal(track.url, "http://emby.test:8096/web/index.html#!/item?id=t1");
});

test("albums, artists and playlists map to the app's shapes", async () => {
  signedIn();
  handler = (url) => {
    if (url.pathname === "/emby/Users/u1/Items/al1") {
      return {
        status: 200,
        body: {
          Id: "al1",
          Name: "Album",
          ImageTags: { Primary: "atag" },
          AlbumArtists: [{ Id: "ar1", Name: "Artist" }],
          UserData: { IsFavorite: true },
          ProductionYear: 2020,
        },
      };
    }
    if (url.pathname === "/emby/Users/u1/Items") {
      return {
        status: 200,
        body: {
          Items: [
            { Id: "t1", Name: "Song", AlbumId: "al1", Album: "Album", RunTimeTicks: 10000000 },
          ],
          TotalRecordCount: 1,
        },
      };
    }
    return { status: 404, body: {} };
  };

  const page = await plugin.album({ id: "al1" });
  assert.equal(page.album.id, "al1");
  assert.equal(page.album.saved, true);
  assert.equal(page.album.released, "2020");
  assert.equal(page.album.imageUrl, albumImage("al1", "atag"));
  assert.equal(page.tracks.length, 1);
});

test("covers come from the item Emby says they are inherited from", async () => {
  // Emby 4.8 leaves ImageTags empty for freshly scanned albums and names the
  // item that holds the cover with PrimaryImageItemId instead.
  signedIn();
  const inherited = {
    Id: "t1",
    Name: "Song",
    AlbumId: "al1",
    Album: "Album",
    PrimaryImageTag: "ptag",
    PrimaryImageItemId: "song1",
    RunTimeTicks: 10000000,
  };
  handler = (url) => {
    if (url.pathname === "/emby/Users/u1/Items/al1") {
      return {
        status: 200,
        body: { Id: "al1", Name: "Album", PrimaryImageTag: "ptag", PrimaryImageItemId: "song1" },
      };
    }
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    return { status: 200, body: { Items: [inherited], TotalRecordCount: 1 } };
  };

  const page = await plugin.album({ id: "al1" });
  assert.equal(page.album.imageUrl, albumImage("song1", "ptag"));
  assert.equal(page.tracks[0].album.imageUrl, albumImage("song1", "ptag"));
});

test("streams direct files when their format is known, and transcodes otherwise", async () => {
  signedIn();
  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items/t1");
    assert.equal(url.searchParams.get("Fields"), "MediaSources,MediaStreams");
    return {
      status: 200,
      body: {
        Id: "t1",
        Container: "flac",
        MediaSources: [
          {
            Bitrate: 900000,
            MediaStreams: [{ Type: "Audio", Codec: "flac" }],
          },
        ],
      },
    };
  };

  const lossless = await plugin.stream({ id: "t1", quality: "lossless" });
  assert.equal(lossless.type, "flac");
  assert.equal(lossless.quality, "lossless");
  assert.equal(lossless.bitRate, 900000);
  assert.equal(new URL(lossless.url).pathname, "/emby/Audio/t1/stream");
  assert.equal(new URL(lossless.url).searchParams.get("static"), "true");
  assert.equal(lossless.headers["X-Emby-Token"], "tok");

  const high = await plugin.stream({ id: "t1", quality: "high" });
  assert.equal(high.type, "flac");
  assert.equal(high.quality, "lossless");

  const standard = await plugin.stream({ id: "t1", quality: "standard" });
  assert.equal(standard.type, "mp3");
  assert.equal(standard.quality, "standard");
  assert.equal(new URL(standard.url).pathname, "/emby/Audio/t1/universal");
  assert.equal(new URL(standard.url).searchParams.get("MaxStreamingBitrate"), "128000");

  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items/t2");
    return {
      status: 200,
      body: { Id: "t2", Container: "wma", MediaSources: [{ MediaStreams: [{ Type: "Audio", Codec: "wma" }] }] },
    };
  };
  const fallback = await plugin.stream({ id: "t2", quality: "lossless" });
  assert.equal(fallback.type, "mp3");
  assert.equal(fallback.quality, "high");
  assert.equal(new URL(fallback.url).pathname, "/emby/Audio/t2/universal");
});

test("playlist writes use the entry ids Emby returned", async () => {
  signedIn();
  handler = (url, options) => {
    if (url.pathname === "/emby/Playlists/p1/Items" && options.method === "GET") {
      return {
        status: 200,
        body: {
          Items: [
            { Id: "a", PlaylistItemId: "e1" },
            { Id: "b", PlaylistItemId: "e2" },
            { Id: "a", PlaylistItemId: "e3" },
          ],
        },
      };
    }
    return { status: 200, body: {} };
  };

  await plugin.removeFromPlaylist({ id: "p1", trackIds: ["a"] });
  const remove = calls.find((call) => call.options.method === "DELETE");
  assert.equal(remove.url.pathname, "/emby/Playlists/p1/Items");
  assert.equal(remove.url.searchParams.get("EntryIds"), "e1,e3");

  calls.length = 0;
  await plugin.movePlaylistTrack({ id: "p1", from: 1, to: 0 });
  const move = calls.find((call) => call.options.method === "POST");
  assert.equal(move.url.pathname, "/emby/Playlists/p1/Items/e2/Move/0");
});

test("favorites check every requested id, in chunks", async () => {
  signedIn();
  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    const ids = url.searchParams.get("Ids").split(",");
    return {
      status: 200,
      body: {
        Items: ids.map((id) => ({ Id: id, UserData: { IsFavorite: id === "yes" } })),
      },
    };
  };

  const ids = [...Array.from({ length: 60 }, (_, index) => `id${index}`), "yes"];
  const liked = await plugin.isLiked({ ids });
  assert.equal(Object.keys(liked).length, ids.length);
  assert.equal(liked.yes, true);
  assert.equal(liked.id0, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get("Ids").split(",").length, 50);
  assert.equal(calls[1].url.searchParams.get("Ids").split(",").length, 11);
});

test("home leads with the daily mix, then recent, liked, saved and followed", async () => {
  signedIn();
  freeze(8);
  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    const params = url.searchParams;
    if (params.get("IncludeItemTypes") === "Audio") {
      if (params.get("Filters") === "IsFavorite") {
        assert.ok(["12", "40"].includes(params.get("Limit")));
        return { status: 200, body: { Items: [{ Id: "fav1", Name: "Loved", RunTimeTicks: 10000000 }] } };
      }
      return { status: 200, body: { Items: [{ Id: "t1", Name: "Song", RunTimeTicks: 10000000 }] } };
    }
    if (params.get("IncludeItemTypes") === "MusicArtist") {
      assert.equal(params.get("Filters"), "IsFavorite");
      assert.equal(params.get("Limit"), "12");
      return { status: 200, body: { Items: [{ Id: "ar1", Name: "Artist" }] } };
    }
    assert.equal(params.get("IncludeItemTypes"), "MusicAlbum");
    if (params.get("Filters") === "IsFavorite") {
      if (params.get("Limit") !== "12") return { status: 200, body: { Items: [] } };
      assert.equal(params.get("SortBy"), "DateCreated");
      return { status: 200, body: { Items: [{ Id: "al2", Name: "Favorite" }] } };
    }
    if (params.get("SortBy") === "DateCreated") {
      assert.equal(params.get("SortOrder"), "Descending");
      assert.equal(params.get("Limit"), "12");
      return { status: 200, body: { Items: [{ Id: "al1", Name: "New" }] } };
    }
    return { status: 200, body: { Items: [] } };
  };

  const home = await plugin.home();
  assert.deepEqual(
    home.sections.map((section) => section.title),
    ["Daily Mix", "Recently Added", "Favorite Songs", "Favorite Albums", "Followed Artists"],
  );
  assert.equal(home.sections[0].morePage, undefined);
  // The card opens the section's own page, headed with the day: the title it
  // shows there, and the slot after the song count.
  assert.equal(home.sections[0].pageTitle, "Daily Mix");
  assert.equal(home.sections[0].subtitle, "Morning mix");
  assert.equal(home.sections[1].morePage, "recent");
  assert.equal(home.sections[2].morePage, "favorites");
  assert.equal(home.sections[3].morePage, "favoriteAlbums");
  assert.equal(home.sections[4].morePage, "artists");
  assert.deepEqual(home.sections[0].tracks.map((track) => track.id).sort(), ["fav1", "t1"]);
  assert.equal(home.sections[1].albums[0].name, "New");
  assert.equal(home.sections[2].tracks[0].id, "fav1");
  assert.equal(home.sections[3].albums[0].name, "Favorite");
  assert.equal(home.sections[4].artists[0].name, "Artist");
});

test("the daily mix is made once and shared by home and its page", async () => {
  signedIn();
  freeze(8);
  let unplayed = 0;
  handler = (url) => {
    const params = url.searchParams;
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    if (params.get("IncludeItemTypes") === "Audio") {
      if (params.get("Filters") === "IsUnplayed") {
        unplayed++;
        return { status: 200, body: { Items: [{ Id: "fresh", Name: "Fresh", RunTimeTicks: 10000000 }] } };
      }
      return { status: 200, body: { Items: [{ Id: "top", Name: "Top", RunTimeTicks: 10000000 }] } };
    }
    return { status: 200, body: { Items: [] } };
  };

  const first = await plugin.browse({ page: "daily" });
  assert.equal(unplayed, 2);
  const second = await plugin.browse({ page: "daily" });
  assert.equal(unplayed, 2);
  assert.deepEqual(
    second.sections[0].tracks.map((track) => track.id),
    first.sections[0].tracks.map((track) => track.id),
  );
  assert.ok(first.sections[0].tracks.some((track) => track.id === "fresh"));
  // The page is headed with the day and the slot, plainly, as Frequently
  // Played is.
  assert.match(first.subtitle, /^[A-Z][a-z]+, [A-Z][a-z]+ \d+ · Morning mix$/);
  assert.equal(first.imageUrl, undefined);
  assert.ok(first.description.includes("new every day"));
});

test("the daily mix fills forty songs and repeats none", async () => {
  signedIn();
  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    assert.equal(url.searchParams.get("IncludeItemTypes"), "Audio");
    return {
      status: 200,
      body: {
        Items: Array.from({ length: 50 }, (_, index) => ({ Id: `t${index}`, Name: `T${index}`, RunTimeTicks: 10000000 })),
        TotalRecordCount: 50,
      },
    };
  };

  const page = await plugin.browse({ page: "daily" });
  const ids = page.sections[0].tracks.map((track) => track.id);
  assert.equal(ids.length, 40);
  assert.equal(new Set(ids).size, 40);
});

test("the daily mix opens with familiar songs in the morning and a new one at night", async () => {
  signedIn();
  const top = Array.from({ length: 12 }, (_, index) => mixItem(`p${index}`, `ap${index}`));
  const favorites = Array.from({ length: 12 }, (_, index) => mixItem(`f${index}`, `af${index}`));
  const mix = Array.from({ length: 20 }, (_, index) => mixItem(`m${index}`, `am${index}`));
  const recent = Array.from({ length: 20 }, (_, index) => mixItem(`n${index}`, `an${index}`));
  const fresh = new Set(recent.map((item) => item.Id));
  handler = dailySource({ top, favorites, mix, recent });

  freeze(8);
  const morning = await plugin.browse({ page: "daily" });
  const morningTracks = morning.sections[0].tracks;
  assert.equal(morningTracks.length, 40);
  assert.ok(morningTracks.slice(0, 5).every((track) => !fresh.has(track.id)));
  assert.equal(morningTracks.filter((track) => fresh.has(track.id)).length, 8);
  assert.match(morning.subtitle, / · Morning mix$/);

  freeze(20);
  const evening = await plugin.browse({ page: "daily" });
  const eveningTracks = evening.sections[0].tracks;
  assert.equal(eveningTracks.length, 40);
  assert.ok(eveningTracks.slice(0, 5).some((track) => fresh.has(track.id)));
  assert.equal(eveningTracks.filter((track) => fresh.has(track.id)).length, 16);
  assert.match(evening.subtitle, / · Evening mix$/);
});

test("the daily mix keeps one artist or album from taking it over", async () => {
  signedIn();
  freeze(9);
  // One artist has five songs and one album is shared by three artists, while
  // the rest of the pools can still fill forty songs on their own.
  const top = [
    ...Array.from({ length: 5 }, (_, index) => mixItem(`hot${index}`, "hot-artist")),
    ...Array.from({ length: 3 }, (_, index) => mixItem(`shared${index}`, `shared-artist-${index}`, "shared-album")),
    ...Array.from({ length: 10 }, (_, index) => mixItem(`p${index}`, `ap${index}`)),
  ];
  handler = dailySource({
    top,
    favorites: Array.from({ length: 10 }, (_, index) => mixItem(`f${index}`, `af${index}`)),
    mix: Array.from({ length: 12 }, (_, index) => mixItem(`m${index}`, `am${index}`)),
    recent: Array.from({ length: 8 }, (_, index) => mixItem(`n${index}`, `an${index}`)),
  });

  const tracks = (await plugin.browse({ page: "daily" })).sections[0].tracks;
  assert.equal(tracks.length, 40);
  assert.equal(tracks.filter((track) => track.artists[0].id === "hot-artist").length, 2);
  assert.equal(tracks.filter((track) => track.album.id === "shared-album").length, 2);
  const counts = new Map();
  for (const track of tracks) counts.set(track.artists[0].id, (counts.get(track.artists[0].id) || 0) + 1);
  assert.ok([...counts.values()].every((count) => count <= 2));
});

test("new songs are the latest released ones, with a random fallback", async () => {
  signedIn();
  freeze(9);
  const queried = [];
  handler = (url) => {
    if (url.pathname === "/emby/Items/seed1/InstantMix") return { status: 200, body: { Items: [] } };
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    const params = url.searchParams;
    if (params.get("IncludeItemTypes") === "Audio" && params.get("Filters") === "IsUnplayed") {
      queried.push({ sort: params.get("SortBy"), order: params.get("SortOrder"), limit: params.get("Limit") });
      if (params.get("SortBy") === "Random") {
        return { status: 200, body: { Items: [mixItem("fallback", "fallback-artist")] } };
      }
    }
    if (params.get("IncludeItemTypes") === "MusicAlbum" && params.get("Filters") === "IsFavorite") {
      return { status: 200, body: { Items: [{ Id: "seed1" }] } };
    }
    return { status: 200, body: { Items: [] } };
  };

  const page = await plugin.browse({ page: "daily" });
  const latest = queried.find((query) => query.sort === "PremiereDate");
  const random = queried.find((query) => query.sort === "Random");
  assert.deepEqual(latest, { sort: "PremiereDate", order: "Descending", limit: "100" });
  assert.deepEqual(random, { sort: "Random", order: null, limit: "40" });
  assert.deepEqual(page.sections[0].tracks.map((track) => track.id), ["fallback"]);
});

test("a play is counted for the time of day it happened", async () => {
  signedIn();
  freeze(21);
  handler = () => ({ status: 200, body: {} });
  await plugin.played({ id: "t1" });
  await plugin.played({ id: "t1" });
  assert.deepEqual(JSON.parse(storage.get("slotPlays")), { t1: { evening: 2 } });

  freeze(8);
  await plugin.played({ id: "t2" });
  assert.deepEqual(JSON.parse(storage.get("slotPlays")), { t1: { evening: 2 }, t2: { morning: 1 } });
});

test("the favorites page lists every liked song", async () => {
  signedIn();
  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    assert.equal(url.searchParams.get("IncludeItemTypes"), "Audio");
    assert.equal(url.searchParams.get("Filters"), "IsFavorite");
    assert.equal(url.searchParams.get("SortBy"), "DatePlayed");
    assert.equal(url.searchParams.get("SortOrder"), "Descending");
    return {
      status: 200,
      body: {
        Items: [
          { Id: "a", Name: "A", RunTimeTicks: 10000000 },
          { Id: "b", Name: "B", RunTimeTicks: 10000000 },
        ],
        TotalRecordCount: 2,
      },
    };
  };

  const page = await plugin.browse({ page: "favorites" });
  assert.equal(page.title, "Favorite Songs");
  assert.deepEqual(page.sections[0].tracks.map((track) => track.id), ["a", "b"]);
  assert.equal(page.subtitle, "2 songs");
});

test("the frequent page counts its songs and says how they rank", async () => {
  signedIn();
  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    assert.equal(url.searchParams.get("SortBy"), "PlayCount");
    return { status: 200, body: { Items: [{ Id: "t1", Name: "Song", RunTimeTicks: 10000000 }] } };
  };

  const page = await plugin.browse({ page: "frequent" });
  assert.equal(page.subtitle, "1 songs");
  assert.equal(page.description, "Ranked by play count");
});

test("a song played is marked played on the server", async () => {
  signedIn();
  handler = (url, options) => {
    assert.equal(url.pathname, "/emby/Users/u1/PlayedItems/t1");
    assert.equal(options.method, "POST");
    return { status: 200, body: {} };
  };

  await plugin.played({ id: "t1" });
  assert.equal(calls.length, 1);

  storage.clear();
  calls.length = 0;
  await plugin.played({ id: "t1" });
  assert.equal(calls.length, 0);
});

test("the favorite albums page lists every saved album", async () => {
  signedIn();
  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    assert.equal(url.searchParams.get("IncludeItemTypes"), "MusicAlbum");
    assert.equal(url.searchParams.get("Filters"), "IsFavorite");
    assert.equal(url.searchParams.get("SortBy"), "DateCreated");
    assert.equal(url.searchParams.get("SortOrder"), "Descending");
    return {
      status: 200,
      body: {
        Items: [
          { Id: "al1", Name: "One" },
          { Id: "al2", Name: "Two" },
        ],
        TotalRecordCount: 2,
      },
    };
  };

  const page = await plugin.browse({ page: "favoriteAlbums" });
  assert.equal(page.title, "Favorite Albums");
  assert.deepEqual(page.sections[0].albums.map((album) => album.name), ["One", "Two"]);
});

test("the recent page is every album, newest first", async () => {
  signedIn();
  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    assert.equal(url.searchParams.get("IncludeItemTypes"), "MusicAlbum");
    assert.equal(url.searchParams.get("SortBy"), "DateCreated");
    assert.equal(url.searchParams.get("SortOrder"), "Descending");
    const start = Number(url.searchParams.get("StartIndex"));
    const limit = Number(url.searchParams.get("Limit"));
    const items = Array.from({ length: Math.max(0, Math.min(limit, 600 - start)) }, (_, index) => ({
      Id: `a${start + index}`,
      Name: `A${start + index}`,
    }));
    return { status: 200, body: { Items: items, TotalRecordCount: 600 } };
  };

  const page = await plugin.browse({ page: "recent" });
  assert.equal(page.title, "Recently Added");
  assert.equal(page.sections.length, 1);
  assert.equal(page.sections[0].albums.length, 600);
  assert.equal(page.sections[0].links, undefined);
});

test("the artists page lists only followed artists", async () => {
  signedIn();
  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    assert.equal(url.searchParams.get("IncludeItemTypes"), "MusicArtist");
    assert.equal(url.searchParams.get("Filters"), "IsFavorite");
    return {
      status: 200,
      body: {
        Items: [{ Id: "ar1", Name: "Artist", UserData: { IsFavorite: true } }],
        TotalRecordCount: 1,
      },
    };
  };

  const page = await plugin.browse({ page: "artists" });
  assert.equal(page.title, "Followed Artists");
  assert.equal(page.sections[0].artists.length, 1);
  assert.equal(page.sections[0].artists[0].following, true);
});

test("all albums fetch every chunk and carry no page links", async () => {
  signedIn();
  handler = (url) => {
    assert.equal(url.pathname, "/emby/Users/u1/Items");
    assert.equal(url.searchParams.get("IncludeItemTypes"), "MusicAlbum");
    assert.equal(url.searchParams.get("SortBy"), "DateCreated");
    assert.equal(url.searchParams.get("SortOrder"), "Descending");
    const start = Number(url.searchParams.get("StartIndex"));
    const limit = Number(url.searchParams.get("Limit"));
    assert.equal(limit, 100);
    const items = Array.from({ length: Math.max(0, Math.min(limit, 4500 - start)) }, (_, index) => ({
      Id: `a${start + index}`,
      Name: `A${start + index}`,
    }));
    return { status: 200, body: { Items: items, TotalRecordCount: 4500 } };
  };

  const page = await plugin.browse({ page: "albums" });
  assert.equal(page.sections.length, 1);
  assert.equal(page.sections[0].albums.length, 4500);
  assert.equal(page.sections[0].albums[0].name, "A0");
  assert.equal(page.sections[0].albums[4499].name, "A4499");
  assert.equal(page.sections[0].links, undefined);
  assert.equal(page.description, undefined);
  assert.equal(page.subtitle, "4500 albums");
});

function trackItem() {
  return {
    status: 200,
    body: {
      Id: "t1",
      Name: "Test Song",
      Album: "Test Album",
      RunTimeTicks: 2000000000,
      Artists: [{ Id: "ar1", Name: "Test Artist" }],
    },
  };
}

function traditionalTrackItem() {
  return {
    status: 200,
    body: {
      Id: "t2",
      Name: "水星記",
      Album: "飛行器的執行週期",
      RunTimeTicks: 3253347850,
      Artists: [{ Id: "ar1", Name: "郭頂" }],
    },
  };
}

test("lyrics come from LRCLIB and are kept", async () => {
  signedIn();
  let asked = 0;
  handler = (url, options) => {
    if (url.hostname === "emby.test") return trackItem();
    assert.equal(url.hostname, "lrclib.net");
    asked++;
    assert.equal(url.pathname, "/api/get");
    assert.equal(url.searchParams.get("track_name"), "Test Song");
    assert.equal(url.searchParams.get("artist_name"), "Test Artist");
    assert.equal(url.searchParams.get("album_name"), "Test Album");
    assert.equal(url.searchParams.get("duration"), "200");
    assert.match(options.headers["User-Agent"], /^MyGo Music Emby plugin/);
    return {
      status: 200,
      body: {
        trackName: "Test Song",
        artistName: "Test Artist",
        duration: 200,
        syncedLyrics: "[00:01.00]First line\n[00:02.00]Second line",
      },
    };
  };

  const first = await plugin.lyrics({ id: "t1" });
  assert.equal(first.lrc, "[00:01.00]First line\n[00:02.00]Second line");
  const second = await plugin.lyrics({ id: "t1" });
  assert.equal(second.lrc, first.lrc);
  assert.equal(asked, 1);
});

test("lyrics fall back to Vkeys when LRCLIB has none", async () => {
  signedIn();
  const hosts = [];
  handler = (url) => {
    if (url.hostname === "emby.test") return trackItem();
    hosts.push(url.hostname);
    if (url.hostname === "lrclib.net") {
      return url.pathname === "/api/get" ? { status: 404, body: {} } : { status: 200, body: [] };
    }
    assert.equal(url.hostname, "api.vkeys.cn");
    if (url.pathname === "/v2/music/tencent/search/song") {
      assert.equal(url.searchParams.get("word"), "Test Song Test Artist");
      assert.equal(url.searchParams.get("num"), "20");
      return {
        status: 200,
        body: {
          code: 200,
          data: [
            { id: 1, song: "Test Song", singer: "Someone Else", interval: "4分00秒" },
            { id: 2, song: "Test Song", singer: "Test Artist", interval: "3分20秒" },
          ],
        },
      };
    }
    assert.equal(url.pathname, "/v2/music/tencent/lyric");
    assert.equal(url.searchParams.get("id"), "2");
    return { status: 200, body: { code: 200, data: { lrc: "[00:05.00]The words" } } };
  };

  const page = await plugin.lyrics({ id: "t1" });
  assert.equal(page.lrc, "[00:05.00]The words");
  assert.ok(!hosts.includes("api.lrcmux.dev"));
});

test("a traditional title is searched again in simplified characters", async () => {
  signedIn();
  handler = (url) => {
    if (url.hostname === "emby.test") return traditionalTrackItem();
    assert.equal(url.hostname, "lrclib.net");
    if (url.pathname === "/api/get") return { status: 404, body: {} };
    if (url.searchParams.get("track_name") === "水星記") {
      assert.equal(url.searchParams.get("artist_name"), "郭頂");
      return { status: 200, body: [] };
    }
    assert.equal(url.searchParams.get("track_name"), "水星记");
    assert.equal(url.searchParams.get("artist_name"), "郭顶");
    return {
      status: 200,
      body: [{ trackName: "水星记", artistName: "郭顶", duration: 325, syncedLyrics: "[00:19.00]First line" }],
    };
  };

  const page = await plugin.lyrics({ id: "t2" });
  assert.equal(page.lrc, "[00:19.00]First line");
});

test("Vkeys matches simplified results to a traditional track", async () => {
  signedIn();
  handler = (url) => {
    if (url.hostname === "emby.test") return traditionalTrackItem();
    if (url.hostname === "lrclib.net") {
      return url.pathname === "/api/get" ? { status: 404, body: {} } : { status: 200, body: [] };
    }
    assert.equal(url.hostname, "api.vkeys.cn");
    if (url.pathname === "/v2/music/tencent/search/song") {
      assert.equal(url.searchParams.get("word"), "水星記 郭頂");
      return {
        status: 200,
        body: {
          code: 200,
          data: [
            { id: 1, song: "水星记", singer: "郭顶", interval: "5分25秒" },
            { id: 2, song: "水星记 (DJ 阿乐版)", singer: "郭顶", interval: "5分41秒" },
          ],
        },
      };
    }
    assert.equal(url.pathname, "/v2/music/tencent/lyric");
    assert.equal(url.searchParams.get("id"), "1");
    return { status: 200, body: { code: 200, data: { lrc: "[00:05.00]La la" } } };
  };

  const page = await plugin.lyrics({ id: "t2" });
  assert.equal(page.lrc, "[00:05.00]La la");
});

test("lrcmux is the last resort when LRCLIB and Vkeys have none", async () => {
  signedIn();
  handler = (url) => {
    if (url.hostname === "emby.test") return trackItem();
    if (url.hostname === "lrclib.net") {
      return url.pathname === "/api/get" ? { status: 404, body: {} } : { status: 200, body: [] };
    }
    if (url.hostname === "api.vkeys.cn") return { status: 200, body: { code: 200, data: [] } };
    assert.equal(url.hostname, "api.lrcmux.dev");
    assert.equal(url.pathname, "/get");
    assert.equal(url.searchParams.get("artist"), "Test Artist");
    assert.equal(url.searchParams.get("title"), "Test Song");
    assert.equal(url.searchParams.get("duration"), "200");
    assert.equal(url.searchParams.get("level"), "line");
    assert.equal(url.searchParams.get("strict"), "true");
    assert.equal(url.searchParams.get("format"), "lrc");
    return { status: 200, text: "[00:03.00]La la\n[00:04.00]La la" };
  };

  const page = await plugin.lyrics({ id: "t1" });
  assert.equal(page.lrc, "[00:03.00]La la\n[00:04.00]La la");
});

test("lyrics choose the closest LRCLIB search result", async () => {
  signedIn();
  handler = (url) => {
    if (url.hostname === "emby.test") return trackItem();
    assert.equal(url.hostname, "lrclib.net");
    if (url.pathname === "/api/get") return { status: 404, body: {} };
    assert.equal(url.pathname, "/api/search");
    return {
      status: 200,
      body: [
        { trackName: "Another Song", artistName: "Test Artist", duration: 200, syncedLyrics: "[00:01.00]Wrong" },
        { trackName: "Test Song", artistName: "Someone Else", duration: 200, syncedLyrics: "[00:02.00]Also wrong" },
        { trackName: "Test Song", artistName: "Test Artist", duration: 199, syncedLyrics: "[00:03.00]Right" },
      ],
    };
  };

  const page = await plugin.lyrics({ id: "t1" });
  assert.equal(page.lrc, "[00:03.00]Right");
});

test("a track with no lyrics is asked for once", async () => {
  signedIn();
  let asked = 0;
  handler = (url) => {
    if (url.hostname === "emby.test") return trackItem();
    asked++;
    return { status: 404, body: {} };
  };

  assert.deepEqual(await plugin.lyrics({ id: "t1" }), {});
  assert.deepEqual(await plugin.lyrics({ id: "t1" }), {});
  assert.equal(asked, 4);
});
