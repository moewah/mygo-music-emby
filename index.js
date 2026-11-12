// SPDX-FileCopyrightText: 2026 MoeWah
// SPDX-License-Identifier: AGPL-3.0-only

// Emby music plugin for MyGo Music.
// Emby serves its REST API under <server>/emby. Settings: server, username and
// password, or an API key. All item IDs are Emby's.

const t = (text) => host.t(text);

// ---------------------------------------------------------------------------
// Errors

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const setupFail = (message) => fail("setup", message);
const signInFail = (message) => fail("signIn", message);
const unavailable = (message) => fail("unavailable", message);

// ---------------------------------------------------------------------------
// The server and its API

function serverConfig() {
  const raw = (host.setting("server") || "").trim();
  if (!raw) throw setupFail(t("Enter your Emby server address in the plugin's settings"));
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "http://" + raw;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw setupFail(t("The server address must be an HTTP or HTTPS address"));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw setupFail(t("The server address must be an HTTP or HTTPS address"));
  }
  if (url.username || url.password || url.search || url.hash) {
    throw setupFail(t("The server address can't hold credentials, a query or a fragment"));
  }
  return { base: url.toString().replace(/\/+$/, "") };
}

function apiBase() {
  const { base } = serverConfig();
  return /\/emby$/i.test(base) ? base : base + "/emby";
}

function webBase() {
  const { base } = serverConfig();
  return base.replace(/\/emby$/i, "");
}

// ---------------------------------------------------------------------------
// Storage and the signed-in session

const store = {
  get(key, fallback = null) {
    const value = host.storage.get(key);
    return value === undefined || value === null ? fallback : value;
  },
  set(key, value) {
    host.storage.set(key, value);
  },
  remove(key) {
    host.storage.remove(key);
  },
};

function token() {
  return store.get("token", "");
}

function currentUserId() {
  return String(store.get("userId", ""));
}

function requireSession() {
  const current = token();
  const userId = currentUserId();
  if (!current || !userId) throw signInFail(t("Sign in to your Emby server"));
  return { token: current, userId };
}

function clearSession() {
  for (const key of ["token", "userId", "userName", "userImageTag", "serverId", "dailyCache"]) store.remove(key);
}

function deviceId() {
  let id = store.get("deviceId", "");
  if (!id) {
    id = host.crypto.md5(`mygo-music-emby-${host.platform}-${host.arch}-${Date.now()}-${Math.random()}`);
    store.set("deviceId", id);
  }
  return id;
}

function clientHeader() {
  return `MediaBrowser Client="MyGo Music", Device="MyGo Music", DeviceId="${deviceId()}", Version="0.1.0"`;
}

// ---------------------------------------------------------------------------
// Requests

function queryString(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    const text = Array.isArray(value) ? value.join(",") : String(value);
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(text));
  }
  return parts.length ? "?" + parts.join("&") : "";
}

async function request(path, options = {}) {
  const { method = "GET", params, body } = options;
  const headers = { Accept: "application/json" };
  const current = token();
  if (current) headers["X-Emby-Token"] = current;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(apiBase() + path + queryString(params), { method, headers, body: payload });
  } catch (error) {
    throw unavailable(t("Can't reach the Emby server") + (error && error.message ? `: ${error.message}` : ""));
  }
  if (response.status === 401) {
    clearSession();
    throw signInFail(t("Your Emby session has ended. Sign in again."));
  }
  if (response.status === 403) {
    throw unavailable(t("Emby refused this request. Check the account's permissions."));
  }
  if (!response.ok) {
    let detail = "";
    try {
      const data = await response.json();
      detail = (data && (data.Message || data.message)) || "";
    } catch {
      // The answer may not be JSON.
    }
    throw unavailable(t("Emby answered") + ` ${response.status}` + (detail ? `: ${detail}` : ""));
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shapes

function pick(object, name, fallback) {
  if (!object) return fallback;
  if (object[name] !== undefined && object[name] !== null) return object[name];
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  if (object[lower] !== undefined && object[lower] !== null) return object[lower];
  return fallback;
}

function imageUrlFor(kind, id, tag) {
  if (!id) return "";
  const parts = ["maxWidth=%7Bsize%7D", "maxHeight=%7Bsize%7D"];
  if (tag) parts.push("tag=" + encodeURIComponent(String(tag)));
  return `${apiBase()}/${kind}/${encodeURIComponent(String(id))}/Images/Primary?${parts.join("&")}`;
}

function imageUrl(id, tag) {
  return imageUrlFor("Items", id, tag);
}

function userImageUrl(id, tag) {
  return imageUrlFor("Users", id, tag);
}

function primaryTag(item) {
  return pick(item, "PrimaryImageTag", "") || pick(pick(item, "ImageTags", {}), "Primary", "");
}

// imageOf is the picture of item, or "" if it has none. An album or artist
// scanned by Emby 4.8 often has no picture of its own: the item it inherits
// one from comes as PrimaryImageItemId, and the picture's tag as
// PrimaryImageTag, while ImageTags stays empty.
function imageOf(item) {
  const inheritedId = pick(item, "PrimaryImageItemId", "");
  const id = inheritedId || pick(item, "Id", "");
  const tag = primaryTag(item);
  return id && (tag || inheritedId) ? imageUrl(id, tag) : "";
}

function peopleOf(item, field) {
  const list = pick(item, field, []);
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) =>
      typeof entry === "string"
        ? { id: "", name: entry }
        : { id: String(pick(entry, "Id", "")), name: pick(entry, "Name", "") },
    )
    .filter((artist) => artist.name);
}

function artistsOf(item) {
  for (const field of ["ArtistItems", "Artists", "AlbumArtists"]) {
    const artists = peopleOf(item, field);
    if (artists.length) return artists;
  }
  const name = pick(item, "AlbumArtist", "");
  return name ? [{ id: "", name }] : [];
}

function albumArtistsOf(item) {
  const albumArtists = peopleOf(item, "AlbumArtists");
  if (albumArtists.length) return albumArtists;
  const artists = peopleOf(item, "Artists");
  if (artists.length) return artists;
  const name = pick(item, "AlbumArtist", "");
  return name ? [{ id: "", name }] : [];
}

function releasedOf(item) {
  const date = pick(item, "PremiereDate", "");
  if (date) return String(date).slice(0, 10);
  const year = pick(item, "ProductionYear", "");
  return year ? String(year) : "";
}

function mediaSourceOf(item) {
  const sources = pick(item, "MediaSources", []);
  return Array.isArray(sources) && sources.length ? sources[0] : {};
}

function durationOf(item) {
  let ticks = Number(pick(item, "RunTimeTicks", 0)) || 0;
  if (!ticks) ticks = Number(pick(mediaSourceOf(item), "RunTimeTicks", 0)) || 0;
  return Math.round(ticks / 10000);
}

function albumOf(item) {
  const id = String(pick(item, "AlbumId", "") || "");
  const name = pick(item, "Album", "");
  const tag = pick(item, "AlbumPrimaryImageTag", "");
  return {
    id,
    name: typeof name === "string" ? name : pick(name, "Name", ""),
    // Use the album's tag when there is one; otherwise the song may carry or
    // inherit the picture.
    imageUrl: id && tag ? imageUrl(id, tag) : imageOf(item),
    artists: albumArtistsOf(item),
    released: releasedOf(item),
  };
}

function toAlbum(item) {
  return {
    id: String(pick(item, "Id", "")),
    name: pick(item, "Name", ""),
    imageUrl: imageOf(item),
    artists: albumArtistsOf(item),
    released: releasedOf(item),
    saved: !!pick(pick(item, "UserData", {}), "IsFavorite", false),
  };
}

function toArtist(item) {
  return {
    id: String(pick(item, "Id", "")),
    name: pick(item, "Name", ""),
    imageUrl: imageOf(item),
    following: !!pick(pick(item, "UserData", {}), "IsFavorite", false),
  };
}

function toTrack(item) {
  const id = String(pick(item, "Id", ""));
  return {
    id,
    name: pick(item, "Name", ""),
    artists: artistsOf(item),
    album: albumOf(item),
    duration: durationOf(item),
    url: id ? `${webBase()}/web/index.html#!/item?id=${encodeURIComponent(id)}` : "",
  };
}

function toPlaylist(item) {
  const count = Number(pick(item, "ChildCount", 0)) || Number(pick(item, "RecursiveItemCount", 0)) || 0;
  const ownerId = String(pick(item, "OwnerUserId", ""));
  const mine = !ownerId || ownerId === currentUserId();
  return {
    id: String(pick(item, "Id", "")),
    name: pick(item, "Name", ""),
    imageUrl: imageOf(item),
    owner: pick(item, "Owner", ""),
    trackCount: count,
    mine,
    ...(mine ? {} : { saved: true }),
  };
}

// ---------------------------------------------------------------------------
// Listing helpers

const ITEM_FIELDS = "UserData,ProductionYear,PremiereDate,ChildCount";

// Ask for a list in pages of 100, ten pages at a time.
const LIST_CHUNK = 100;
const LIST_WORKERS = 10;

function itemsOf(data) {
  return (data && (data.Items || data.items)) || [];
}

function totalOf(data) {
  return Number(pick(data, "TotalRecordCount", 0)) || 0;
}

// soft keeps a failed part of a page empty instead of failing all of it.
function soft(promise, fallback) {
  return promise.catch((error) => {
    if (error && (error.code === "signIn" || error.code === "setup")) throw error;
    return fallback;
  });
}

// collectPages asks for every page of a list, a few pages at a time, and
// answers what it found and how many the server says there are. A page that
// fails is left out rather than failing the rest.
async function collectPages(fetchPage, params) {
  const ask = (start, limit) => soft(fetchPage({ ...params, StartIndex: start, Limit: limit }), null);
  const first = await ask(0, LIST_CHUNK);
  if (!first) return { items: [], total: 0 };
  const seen = new Set();
  const out = [];
  const add = (item) => {
    // A playlist holds a song twice as two entries, each with its own id.
    const id = String(pick(item, "PlaylistItemId", "")) || String(pick(item, "Id", ""));
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    out.push(item);
  };
  const firstItems = itemsOf(first);
  for (const item of firstItems) add(item);
  const total = totalOf(first);
  if (total) {
    if (total <= firstItems.length) return { items: out, total: Math.max(total, out.length) };
    const starts = [];
    for (let start = firstItems.length; start < total; start += LIST_CHUNK) starts.push(start);
    const pages = new Array(starts.length);
    let next = 0;
    const worker = async () => {
      while (next < starts.length) {
        const index = next++;
        pages[index] = await ask(starts[index], Math.min(LIST_CHUNK, total - starts[index]));
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIST_WORKERS, starts.length) }, worker));
    for (const page of pages) {
      if (page) for (const item of itemsOf(page)) add(item);
    }
    return { items: out, total: Math.max(total, out.length) };
  }
  // Emby usually says how many there are. Without that, read on a page at a
  // time until one comes back short.
  let start = firstItems.length;
  let full = firstItems.length === LIST_CHUNK;
  while (full) {
    const page = await ask(start, LIST_CHUNK);
    if (!page) break;
    const pageItems = itemsOf(page);
    for (const item of pageItems) add(item);
    start += pageItems.length;
    full = pageItems.length === LIST_CHUNK;
  }
  return { items: out, total: out.length };
}

function collectItems(params) {
  return collectPages((pageParams) => items(pageParams), params);
}

async function items(params) {
  const session = requireSession();
  return request(`/Users/${encodeURIComponent(session.userId)}/Items`, {
    params: {
      Recursive: "true",
      Fields: ITEM_FIELDS,
      ImageTypeLimit: 1,
      EnableImageTypes: "Primary",
      ...params,
    },
  });
}

async function itemById(id, fields) {
  const session = requireSession();
  return request(`/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(id)}`, {
    params: fields ? { Fields: fields } : undefined,
  });
}

async function favorite(id, on) {
  const session = requireSession();
  await request(`/Users/${encodeURIComponent(session.userId)}/FavoriteItems/${encodeURIComponent(id)}`, {
    method: on ? "POST" : "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Daily mix

// A day as the local calendar names it, for the daily mix's key.
function dayKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// A random source that gives the same run for the same seed, so a day's mix
// is the same each time it's asked for.
function seededRandom(seed) {
  let state = 0;
  for (let index = 0; index < seed.length; index++) state = (state * 31 + seed.charCodeAt(index)) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffled(list, random) {
  const out = list.slice();
  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other], out[index]];
  }
  return out;
}

const DAILY_SIZE = 40;
// How many songs each pool may add: played, liked, similar and new.
const DAILY_QUOTAS = [10, 10, 10, 10];
// Raise this when the recipe changes, so the day's mix is made again.
const DAILY_VERSION = 5;

// dailySubtitle heads the daily page with the day, in the listener's language.
function dailySubtitle(now = new Date()) {
  const lang = typeof host.language === "function" ? host.language() : "en";
  if (lang === "zh-CN") {
    const week = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    return `${now.getMonth() + 1}月${now.getDate()}日 ${week[now.getDay()]}`;
  }
  const week = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${week[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}`;
}

// dailyTracks is the day's mix: songs the listener plays, songs they like,
// songs like those, and songs they haven't played yet. It's kept for the day
// so Home and its page show the same list.
async function dailyTracks() {
  const userId = currentUserId();
  const key = `daily:${DAILY_VERSION}:${userId}:${dayKey()}`;
  try {
    const cached = JSON.parse(store.get("dailyCache", ""));
    if (cached && cached.key === key && Array.isArray(cached.tracks)) return cached.tracks;
  } catch {
    // No mix kept yet.
  }
  const [top, favorites, unplayed, likedAlbums, anyAlbums] = await Promise.all([
    soft(items({ IncludeItemTypes: "Audio", Filters: "IsPlayed", SortBy: "PlayCount", SortOrder: "Descending", Limit: 40 }), { Items: [] }),
    soft(items({ IncludeItemTypes: "Audio", Filters: "IsFavorite", SortBy: "DatePlayed", SortOrder: "Descending", Limit: 40 }), { Items: [] }),
    soft(items({ IncludeItemTypes: "Audio", Filters: "IsUnplayed", SortBy: "Random", Limit: 40 }), { Items: [] }),
    soft(items({ IncludeItemTypes: "MusicAlbum", Filters: "IsFavorite", SortBy: "Random", Limit: 3 }), { Items: [] }),
    soft(items({ IncludeItemTypes: "MusicAlbum", SortBy: "Random", Limit: 3 }), { Items: [] }),
  ]);
  // Seeds from albums the listener likes keep the mixes close to their taste;
  // without any, a random album is all there is to go on.
  const seeds = itemsOf(likedAlbums).length ? itemsOf(likedAlbums) : itemsOf(anyAlbums);
  const mixes = await Promise.all(
    seeds
      .filter((album) => pick(album, "Id", ""))
      .map((album) =>
        soft(
          request(`/Items/${encodeURIComponent(String(pick(album, "Id", "")))}/InstantMix`, {
            params: { UserId: userId, Limit: 20, Fields: ITEM_FIELDS, ImageTypeLimit: 1, EnableImageTypes: "Primary" },
          }),
          { Items: [] },
        ),
      ),
  );
  const pools = [itemsOf(top), itemsOf(favorites), mixes.flatMap((mix) => itemsOf(mix)), itemsOf(unplayed)];
  const picked = [];
  const seen = new Set();
  const add = (item) => {
    const id = String(pick(item, "Id", ""));
    if (!id || seen.has(id)) return false;
    seen.add(id);
    picked.push(item);
    return true;
  };
  pools.forEach((pool, index) => {
    let took = 0;
    for (const item of pool) {
      if (took >= DAILY_QUOTAS[index] || picked.length >= DAILY_SIZE) break;
      if (add(item)) took++;
    }
  });
  for (const pool of pools) {
    for (const item of pool) {
      if (picked.length >= DAILY_SIZE) break;
      add(item);
    }
  }
  const tracks = shuffled(picked, seededRandom(host.crypto.md5(key))).map(toTrack);
  const covered = tracks.findIndex((track) => track.album && track.album.imageUrl);
  if (covered > 0) tracks.unshift(...tracks.splice(covered, 1));
  store.set("dailyCache", JSON.stringify({ key, tracks }));
  return tracks;
}

// ---------------------------------------------------------------------------
// Signing in

function saveSession(accessToken, user, serverId) {
  store.set("token", accessToken);
  store.set("userId", String(pick(user, "Id", "")));
  store.set("userName", pick(user, "Name", ""));
  store.set("userImageTag", primaryTag(user));
  if (serverId) store.set("serverId", String(serverId));
}

function listenerOf(id, name, tag) {
  return {
    id,
    name,
    imageUrl: id && tag ? userImageUrl(id, tag) : "",
    page: "profile",
  };
}

function accountOf(user) {
  return listenerOf(String(pick(user, "Id", "")), pick(user, "Name", "Emby"), primaryTag(user));
}

async function signInWithPassword(username, password) {
  let response;
  try {
    response = await fetch(apiBase() + "/Users/AuthenticateByName", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Emby-Authorization": clientHeader(),
      },
      body: JSON.stringify({ Username: username, Pw: password }),
    });
  } catch (error) {
    throw unavailable(t("Can't reach the Emby server") + (error && error.message ? `: ${error.message}` : ""));
  }
  if (response.status === 401) throw signInFail(t("Wrong username or password"));
  if (!response.ok) throw unavailable(t("Emby answered") + ` ${response.status}`);
  const data = await response.json();
  const user = pick(data, "User", {});
  const accessToken = pick(data, "AccessToken", "");
  if (!accessToken || !pick(user, "Id", "")) throw unavailable(t("Emby's sign-in answer has no token"));
  saveSession(accessToken, user, pick(data, "ServerId", ""));
  return accountOf(user);
}

async function userWithKey(key, path) {
  let response;
  try {
    response = await fetch(apiBase() + path, {
      headers: { Accept: "application/json", "X-Emby-Token": key },
    });
  } catch (error) {
    throw unavailable(t("Can't reach the Emby server") + (error && error.message ? `: ${error.message}` : ""));
  }
  if (response.status === 401) throw signInFail(t("Emby refused the API key"));
  if (!response.ok) return { error: response.status };
  try {
    return { data: await response.json() };
  } catch {
    return { data: null };
  }
}

async function signInWithKey(key) {
  let user = null;
  const me = await userWithKey(key, "/Users/Me");
  if (me.data) user = me.data;
  else if (me.error !== 404) throw unavailable(t("Emby answered") + ` ${me.error}`);
  if (!user || !pick(user, "Id", "")) {
    const all = await userWithKey(key, "/Users");
    if (all.error) throw unavailable(t("Emby answered") + ` ${all.error}`);
    const list = Array.isArray(all.data) ? all.data : itemsOf(all.data);
    user = list.find((entry) => pick(pick(entry, "Policy", {}), "IsAdministrator", false)) || list[0] || null;
  }
  if (!user || !pick(user, "Id", "")) {
    throw signInFail(t("The API key didn't identify a user. Use a username and password instead."));
  }
  saveSession(key, user, "");
  return accountOf(user);
}

export async function signIn() {
  // Check the address before asking Emby anything.
  serverConfig();
  const apiKey = (host.setting("apiKey") || "").trim();
  if (apiKey) return signInWithKey(apiKey);
  const username = (host.setting("username") || "").trim();
  const password = host.setting("password") || "";
  if (!username) throw setupFail(t("Set your Emby username and password, or an API key, in the plugin's settings"));
  return signInWithPassword(username, password);
}

export function account() {
  const current = token();
  const userId = currentUserId();
  if (!current || !userId) return null;
  return listenerOf(userId, store.get("userName", "") || "Emby", store.get("userImageTag", ""));
}

export async function signOut() {
  if (token()) {
    try {
      await request("/Sessions/Logout", { method: "POST" });
    } catch {
      // Signing out locally is enough.
    }
  }
  clearSession();
}

export function setSetting({ key }) {
  // A new address or account makes the saved session stale.
  if (["server", "username", "password", "apiKey"].includes(key)) clearSession();
}

// ---------------------------------------------------------------------------
// Home and pages

export async function home() {
  requireSession();
  const [daily, likedTracksData, newest, favoriteAlbumData, followedArtistData] = await Promise.all([
    soft(dailyTracks(), []),
    soft(items({ IncludeItemTypes: "Audio", Filters: "IsFavorite", SortBy: "DatePlayed", SortOrder: "Descending", Limit: 20 }), { Items: [] }),
    soft(items({ IncludeItemTypes: "MusicAlbum", SortBy: "DateCreated", SortOrder: "Descending", Limit: 10 }), { Items: [] }),
    soft(items({ IncludeItemTypes: "MusicAlbum", Filters: "IsFavorite", SortBy: "DateCreated", SortOrder: "Descending", Limit: 10 }), { Items: [] }),
    soft(items({ IncludeItemTypes: "MusicArtist", Filters: "IsFavorite", SortBy: "SortName", Limit: 10 }), { Items: [] }),
  ]);
  const sections = [];
  if (daily.length) sections.push({ title: t("Daily Mix"), tracks: daily, morePage: "daily" });
  const likedTracks = itemsOf(likedTracksData).map(toTrack);
  if (likedTracks.length) sections.push({ title: t("Favorite Songs"), tracks: likedTracks, morePage: "favorites" });
  const albums = itemsOf(newest).map(toAlbum);
  if (albums.length) sections.push({ title: t("Recently Added"), albums, morePage: "recent" });
  const favoriteAlbums = itemsOf(favoriteAlbumData).map(toAlbum);
  if (favoriteAlbums.length) sections.push({ title: t("Favorite Albums"), albums: favoriteAlbums, morePage: "favoriteAlbums" });
  const artists = itemsOf(followedArtistData).map(toArtist);
  if (artists.length) sections.push({ title: t("Followed Artists"), artists, morePage: "artists" });
  return {
    title: "Emby",
    sections,
    ...(sections.length ? {} : { description: t("Nothing here yet") }),
  };
}

async function profilePage() {
  const session = requireSession();
  const [likedTracks, savedAlbumData, playlistData] = await Promise.all([
    items({ IncludeItemTypes: "Audio", Filters: "IsFavorite", SortBy: "DatePlayed", SortOrder: "Descending", Limit: 20 }),
    items({ IncludeItemTypes: "MusicAlbum", Filters: "IsFavorite", SortBy: "DateCreated", SortOrder: "Descending", Limit: 20 }),
    playlistList(),
  ]);
  const tag = store.get("userImageTag", "");
  return {
    title: store.get("userName", "") || "Emby",
    imageUrl: tag ? userImageUrl(session.userId, tag) : "",
    sections: [
      { title: t("Favorite Songs"), tracks: itemsOf(likedTracks).map(toTrack), empty: t("No favorites yet") },
      { title: t("Favorite Albums"), albums: itemsOf(savedAlbumData).map(toAlbum), empty: t("No favorite albums yet") },
      { title: t("Playlists"), playlists: playlistData, empty: t("No playlists yet") },
    ],
  };
}

export async function browse({ page }) {
  requireSession();
  if (page === "profile") return profilePage();
  if (page === "daily") return dailyPage();
  if (page === "frequent") return frequentPage();
  if (page === "favorites") return favoritesPage();
  if (page === "recent") return albumsPage(true);
  if (page === "albums") return albumsPage();
  if (page === "favoriteAlbums") return favoriteAlbumsPage();
  if (page === "artists") return artistsPage();
  throw unavailable(t("No such page"));
}

async function dailyPage() {
  const tracks = await dailyTracks();
  return {
    title: t("Daily Mix"),
    subtitle: dailySubtitle(),
    description:
      t("A mix of what you play and like, new every day") + (tracks.length ? `\n${tracks.length} ${t("songs")}` : ""),
    sections: [{ tracks, empty: t("Nothing here yet") }],
  };
}

async function favoritesPage() {
  const { items: list } = await collectItems({
    IncludeItemTypes: "Audio",
    Filters: "IsFavorite",
    SortBy: "DatePlayed",
    SortOrder: "Descending",
  });
  const tracks = list.map(toTrack);
  return {
    title: t("Favorite Songs"),
    subtitle: tracks.length ? `${tracks.length} ${t("songs")}` : "",
    sections: [{ tracks, empty: t("No favorites yet") }],
  };
}

async function frequentPage() {
  const data = await items({ IncludeItemTypes: "Audio", Filters: "IsPlayed", SortBy: "PlayCount", SortOrder: "Descending", Limit: 100 });
  const tracks = itemsOf(data).map(toTrack);
  return {
    title: t("Frequently Played"),
    subtitle: tracks.length ? `${tracks.length} ${t("songs")}` : "",
    description: t("Ranked by play count"),
    sections: [{ tracks, empty: t("Nothing played yet") }],
  };
}

// albumsPage lists every album, newest first. Home's Recently Added opens the
// same list under its own name.
async function albumsPage(recent = false) {
  const { items: list, total } = await collectItems({
    IncludeItemTypes: "MusicAlbum",
    SortBy: "DateCreated",
    SortOrder: "Descending",
  });
  return {
    title: recent ? t("Recently Added") : t("All Albums"),
    subtitle: list.length ? `${list.length} ${t("albums")}` : "",
    ...(list.length < total ? { description: t("Some albums aren't shown") } : {}),
    sections: [{ albums: list.map(toAlbum), empty: t("No albums") }],
  };
}

async function favoriteAlbumsPage() {
  const { items: list, total } = await collectItems({
    IncludeItemTypes: "MusicAlbum",
    Filters: "IsFavorite",
    SortBy: "DateCreated",
    SortOrder: "Descending",
  });
  const albums = list.map(toAlbum);
  return {
    title: t("Favorite Albums"),
    subtitle: albums.length ? `${albums.length} ${t("albums")}` : "",
    ...(list.length < total ? { description: t("Some albums aren't shown") } : {}),
    sections: [{ albums, empty: t("No favorite albums yet") }],
  };
}

async function artistsPage() {
  const { items: list } = await collectItems({
    IncludeItemTypes: "MusicArtist",
    Filters: "IsFavorite",
    SortBy: "SortName",
  });
  const artists = list.map(toArtist);
  return {
    title: t("Followed Artists"),
    subtitle: artists.length ? `${artists.length} ${t("artists")}` : "",
    sections: [{ artists, empty: t("No followed artists yet") }],
  };
}

// ---------------------------------------------------------------------------
// Search and favorites

const SEARCH_PAGE_SIZE = 50;

const SEARCH_TYPES = {
  tracks: "Audio",
  albums: "MusicAlbum",
  artists: "MusicArtist",
  playlists: "Playlist",
};

export async function search({ query, kind, offset }) {
  requireSession();
  const type = SEARCH_TYPES[kind];
  const text = (query || "").trim();
  if (!type || !text) return { more: false };
  const start = Number(offset) || 0;
  const data = await items({
    IncludeItemTypes: type,
    SearchTerm: text,
    StartIndex: start,
    Limit: SEARCH_PAGE_SIZE,
    SortBy: "SortName",
  });
  let list = itemsOf(data);
  if (kind === "playlists") {
    list = list.filter((entry) => String(pick(entry, "MediaType", "")).toLowerCase() !== "video");
  }
  const result = { more: start + list.length < totalOf(data) };
  if (kind === "tracks") result.tracks = list.map(toTrack);
  if (kind === "albums") result.albums = list.map(toAlbum);
  if (kind === "artists") result.artists = list.map(toArtist);
  if (kind === "playlists") result.playlists = list.map(toPlaylist);
  return result;
}

export async function liked({ offset }) {
  const start = Number(offset) || 0;
  const data = await items({
    IncludeItemTypes: "Audio",
    Filters: "IsFavorite",
    SortBy: "DatePlayed",
    SortOrder: "Descending",
    StartIndex: start,
    Limit: 200,
  });
  const list = itemsOf(data);
  return { tracks: list.map(toTrack), more: start + list.length < totalOf(data) };
}

export async function isLiked({ ids }) {
  const wanted = (ids || []).map(String);
  const liked = {};
  for (let index = 0; index < wanted.length; index += 50) {
    const chunk = wanted.slice(index, index + 50);
    const data = await items({ Ids: chunk.join(","), Limit: chunk.length, Fields: "UserData" });
    for (const entry of itemsOf(data)) {
      liked[String(pick(entry, "Id", ""))] = !!pick(pick(entry, "UserData", {}), "IsFavorite", false);
    }
  }
  for (const id of wanted) {
    if (!(id in liked)) liked[id] = false;
  }
  return liked;
}

// Liking a song, saving an album and following an artist are the same
// favorite flag in Emby.
export async function like({ id, on }) {
  await favorite(id, on);
}

export async function saveAlbum({ id, on }) {
  await favorite(id, on);
}

export async function followArtist({ id, on }) {
  await favorite(id, on);
}

export async function savedAlbums({ offset }) {
  const start = Number(offset) || 0;
  const data = await items({
    IncludeItemTypes: "MusicAlbum",
    Filters: "IsFavorite",
    SortBy: "DateCreated",
    SortOrder: "Descending",
    StartIndex: start,
    Limit: 200,
  });
  const list = itemsOf(data);
  return { albums: list.map(toAlbum), more: start + list.length < totalOf(data) };
}

export async function recent() {
  const data = await items({
    IncludeItemTypes: "Audio",
    Filters: "IsPlayed",
    SortBy: "DatePlayed",
    SortOrder: "Descending",
    Limit: 50,
  });
  return itemsOf(data).map(toTrack);
}

// played tells Emby the song played, so its play count and the day it last
// played move without it streaming the audio itself.
export async function played({ id }) {
  const current = token();
  const userId = currentUserId();
  if (!current || !userId || !id) return;
  try {
    await request(`/Users/${encodeURIComponent(userId)}/PlayedItems/${encodeURIComponent(String(id))}`, { method: "POST" });
  } catch (error) {
    console.warn(`marking ${id} as played: ${error && error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Albums, artists and playlists

export async function album({ id }) {
  const [item, trackData] = await Promise.all([
    itemById(id),
    collectItems({ ParentId: id, IncludeItemTypes: "Audio", SortBy: "ParentIndexNumber,IndexNumber,SortName" }),
  ]);
  return { album: toAlbum(item), tracks: trackData.items.map(toTrack) };
}

export async function artist({ id }) {
  const [item, trackData, albumData] = await Promise.all([
    itemById(id),
    items({ ArtistIds: id, IncludeItemTypes: "Audio", SortBy: "PlayCount,SortName", SortOrder: "Descending", Limit: 20 }),
    collectItems({
      AlbumArtistIds: id,
      IncludeItemTypes: "MusicAlbum",
      SortBy: "ProductionYear,SortName",
      SortOrder: "Descending",
    }),
  ]);
  return {
    artist: toArtist(item),
    tracks: itemsOf(trackData).map(toTrack),
    albums: albumData.items.map(toAlbum),
  };
}

async function playlistList() {
  const data = await items({ IncludeItemTypes: "Playlist", SortBy: "SortName", Limit: 500 });
  return itemsOf(data)
    .filter((entry) => String(pick(entry, "MediaType", "")).toLowerCase() !== "video")
    .map(toPlaylist);
}

export function playlists() {
  return playlistList();
}

async function playlistEntries(id) {
  const session = requireSession();
  const { items } = await collectPages(
    (params) =>
      request(`/Playlists/${encodeURIComponent(id)}/Items`, {
        params: {
          UserId: session.userId,
          Fields: ITEM_FIELDS,
          ImageTypeLimit: 1,
          EnableImageTypes: "Primary",
          ...params,
        },
      }),
    {},
  );
  return items;
}

export async function playlist({ id }) {
  const [item, entries] = await Promise.all([itemById(id), playlistEntries(id)]);
  const result = toPlaylist(item);
  result.tracks = entries.map(toTrack);
  result.trackCount = entries.length;
  return result;
}

export async function createPlaylist({ name }) {
  const session = requireSession();
  const data = await request("/Playlists", {
    method: "POST",
    params: { Name: name, UserId: session.userId, MediaType: "Audio" },
  });
  const id = pick(data, "Id", "");
  if (!id) throw unavailable(t("Emby didn't create the playlist"));
  return { id: String(id), name, mine: true, trackCount: 0 };
}

export async function renamePlaylist({ id, name }) {
  let item = null;
  try {
    item = await itemById(id);
  } catch {
    item = { Id: id, Name: name, Type: "Playlist" };
  }
  item.Name = name;
  try {
    await request(`/Items/${encodeURIComponent(id)}`, { method: "POST", body: item });
  } catch {
    await request(`/Items/${encodeURIComponent(id)}`, { method: "POST", body: { Id: id, Name: name } });
  }
}

export async function deletePlaylist({ id }) {
  try {
    await request(`/Items/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    await request(`/Items/${encodeURIComponent(id)}/Delete`, { method: "POST" });
  }
}

export async function addToPlaylist({ id, trackIds }) {
  const session = requireSession();
  const ids = (trackIds || []).map(String);
  if (!ids.length) return;
  await request(`/Playlists/${encodeURIComponent(id)}/Items`, {
    method: "POST",
    params: { Ids: ids.join(","), UserId: session.userId },
  });
}

export async function removeFromPlaylist({ id, trackIds }) {
  const remove = new Set((trackIds || []).map(String));
  if (!remove.size) return;
  const entries = await playlistEntries(id);
  const entryIds = [];
  for (const entry of entries) {
    const entryId = String(pick(entry, "PlaylistItemId", ""));
    if (entryId && remove.has(String(pick(entry, "Id", "")))) entryIds.push(entryId);
  }
  if (!entryIds.length) return;
  const session = requireSession();
  await request(`/Playlists/${encodeURIComponent(id)}/Items`, {
    method: "DELETE",
    params: { EntryIds: entryIds.join(","), UserId: session.userId },
  });
}

export async function movePlaylistTrack({ id, from, to }) {
  const entries = await playlistEntries(id);
  const entry = entries[Number(from)];
  const entryId = entry && String(pick(entry, "PlaylistItemId", ""));
  if (!entryId) throw unavailable(t("The playlist has no such track"));
  const session = requireSession();
  await request(
    `/Playlists/${encodeURIComponent(id)}/Items/${encodeURIComponent(entryId)}/Move/${encodeURIComponent(to)}`,
    { method: "POST", params: { UserId: session.userId } },
  );
}

// ---------------------------------------------------------------------------
// Streaming

function mediaStreamsOf(item) {
  const own = pick(item, "MediaStreams", []);
  if (Array.isArray(own) && own.length) return own;
  const mediaStreams = pick(mediaSourceOf(item), "MediaStreams", []);
  return Array.isArray(mediaStreams) ? mediaStreams : [];
}

function audioCodecOf(item) {
  const stream = mediaStreamsOf(item).find(
    (entry) => String(pick(entry, "Type", "")).toLowerCase() === "audio",
  );
  return String(pick(stream || {}, "Codec", "")).toLowerCase();
}

function bitRateOf(item) {
  const source = mediaSourceOf(item);
  return Number(pick(source, "Bitrate", 0)) || Number(pick(source, "BitRate", 0)) || 0;
}

function formatOf(item) {
  const container = String(pick(item, "Container", "") || pick(mediaSourceOf(item), "Container", ""))
    .split(",")[0]
    .trim()
    .toLowerCase();
  const codec = audioCodecOf(item);
  const byContainer = {
    mp3: "mp3",
    flac: "flac",
    ogg: "ogg",
    oga: "ogg",
    wav: "wav",
    m4a: "m4a",
    mp4: "m4a",
    alac: "m4a",
    aac: "aac",
  };
  const byCodec = {
    mp3: "mp3",
    flac: "flac",
    vorbis: "ogg",
    wav: "wav",
    pcm_s16le: "wav",
    pcm_s24le: "wav",
    alac: "m4a",
    aac: "m4a",
  };
  let type = byContainer[container] || byCodec[codec] || "";
  // The app plays no Opus, so it goes through the transcoder.
  if (codec === "opus") type = "";
  return { type, codec, bitRate: bitRateOf(item) };
}

function isLossless(type, codec) {
  return type === "flac" || type === "wav" || codec === "flac" || codec === "alac" || /^pcm_/.test(codec);
}

export async function stream({ id, quality }) {
  const session = requireSession();
  const item = await itemById(id, "MediaSources,MediaStreams");
  if (!item) throw unavailable(t("The track isn't available"));
  const format = formatOf(item);
  const requested = ["standard", "high", "lossless"].includes(quality) ? quality : "high";
  let direct = !!format.type;
  // Standard asks for 128 kbps or less: only an MP3 known to be that low plays
  // as it is.
  if (requested === "standard" && !(format.type === "mp3" && format.bitRate && format.bitRate <= 128000)) {
    direct = false;
  }
  if (direct) {
    return {
      url: `${apiBase()}/Audio/${encodeURIComponent(id)}/stream${queryString({
        static: "true",
        DeviceId: deviceId(),
        UserId: session.userId,
      })}`,
      type: format.type,
      quality: isLossless(format.type, format.codec)
        ? "lossless"
        : requested === "standard"
          ? "standard"
          : "high",
      ...(format.bitRate ? { bitRate: format.bitRate } : {}),
      headers: { "X-Emby-Token": session.token },
    };
  }
  const bitRate = requested === "standard" ? 128000 : 320000;
  return {
    url: `${apiBase()}/Audio/${encodeURIComponent(id)}/universal${queryString({
      UserId: session.userId,
      DeviceId: deviceId(),
      MaxStreamingBitrate: bitRate,
      AudioBitRate: bitRate,
      Container: "mp3",
      AudioCodec: "mp3",
      TranscodingContainer: "mp3",
      TranscodingProtocol: "http",
    })}`,
    type: "mp3",
    quality: requested === "standard" ? "standard" : "high",
    bitRate,
    headers: { "X-Emby-Token": session.token },
  };
}
