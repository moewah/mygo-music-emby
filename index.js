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
  for (const key of ["token", "userId", "userName", "userImageTag", "serverId", "dailyCache", "slotPlays"]) store.remove(key);
  clearLyrics();
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
  return `MediaBrowser Client="MyGo Music", Device="MyGo Music", DeviceId="${deviceId()}", Version="0.3.0"`;
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

// The host's clock when it has one, so the mix's time of day can be tested.
function nowDate() {
  const time = typeof host.now === "function" ? host.now() : Date.now();
  return new Date(time);
}

// A day as the local calendar names it, for the daily mix's key.
function dayKey(date = nowDate()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// The day has three slots of its own. Morning runs from five to eleven, the
// middle of the day until five, and the evening through the night.
function slotOf(date = nowDate()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "noon";
  return "evening";
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
// How many songs each pool may add: played, liked, similar and new. Mornings
// lean on what the listener knows; evenings make room for new songs.
const DAILY_QUOTAS = {
  morning: [10, 10, 12, 8],
  noon: [8, 8, 12, 12],
  evening: [6, 6, 12, 16],
};
// One artist or album shouldn't fill the mix on their own.
const DAILY_ARTIST_LIMIT = 2;
const DAILY_ALBUM_LIMIT = 2;
// How many songs the mix opens with, before new ones may lead it.
const DAILY_FAMILIAR_OPENING = 5;
// Raise this when the recipe changes, so the day's mix is made again.
const DAILY_VERSION = 6;

// What the day's slot is called, in the listener's language.
function slotLabel(slot, lang) {
  const zh = lang === "zh-CN";
  if (slot === "morning") return zh ? "早间推荐" : "Morning mix";
  if (slot === "noon") return zh ? "午间推荐" : "Midday mix";
  return zh ? "晚间推荐" : "Evening mix";
}

// The listener's language, for the mix's labels.
function lang() {
  return typeof host.language === "function" ? host.language() : "en";
}

// dailySubtitle heads the daily page with the day and its slot, in the
// listener's language.
function dailySubtitle(date = nowDate()) {
  const slot = slotOf(date);
  if (lang() === "zh-CN") {
    const week = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    return `${date.getMonth() + 1}月${date.getDate()}日 ${week[date.getDay()]} · ${slotLabel(slot, lang())}`;
  }
  const week = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${week[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()} · ${slotLabel(slot, lang())}`;
}

// dailyTracks is the mix for this part of the day: songs the listener plays,
// songs they like, songs like those, and songs they haven't played yet. It's
// kept for the day and slot so Home and its page show the same list.
async function dailyTracks() {
  const userId = currentUserId();
  const slot = slotOf();
  const key = `daily:${DAILY_VERSION}:${userId}:${dayKey()}:${slot}`;
  try {
    const cached = JSON.parse(store.get("dailyCache", ""));
    if (cached && cached.key === key && Array.isArray(cached.tracks)) return cached.tracks;
  } catch {
    // No mix kept yet.
  }
  const [top, favorites, recentNew, unplayed, likedAlbums, anyAlbums] = await Promise.all([
    soft(items({ IncludeItemTypes: "Audio", Filters: "IsPlayed", SortBy: "PlayCount", SortOrder: "Descending", Limit: 40 }), { Items: [] }),
    soft(items({ IncludeItemTypes: "Audio", Filters: "IsFavorite", SortBy: "DatePlayed", SortOrder: "Descending", Limit: 40 }), { Items: [] }),
    // New songs are the ones released most recently, as long as they haven't
    // played yet.
    soft(items({ IncludeItemTypes: "Audio", Filters: "IsUnplayed", SortBy: "PremiereDate", SortOrder: "Descending", Limit: 100 }), { Items: [] }),
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
  // The random unplayed songs catch a library whose newest release is old.
  const fresh = itemsOf(recentNew).concat(itemsOf(unplayed));
  const pools = [itemsOf(top), itemsOf(favorites), mixes.flatMap((mix) => itemsOf(mix)), fresh];
  const picked = [];
  const seen = new Set();
  const freshIds = new Set();
  const artistUses = new Map();
  const albumUses = new Map();
  const add = (item, strict, isFresh) => {
    const id = String(pick(item, "Id", ""));
    if (!id || seen.has(id)) return false;
    const artist = artistsOf(item)[0];
    const artistKey = artist ? (artist.id ? `id:${artist.id}` : `name:${String(artist.name).toLowerCase()}`) : "";
    const albumKey = albumOf(item).id;
    // The first pass keeps one artist or album from filling the mix. The
    // second pass, only reached when there aren't enough songs, lets that go.
    if (strict) {
      if (artistKey && (artistUses.get(artistKey) || 0) >= DAILY_ARTIST_LIMIT) return false;
      if (albumKey && (albumUses.get(albumKey) || 0) >= DAILY_ALBUM_LIMIT) return false;
    }
    seen.add(id);
    if (artistKey) artistUses.set(artistKey, (artistUses.get(artistKey) || 0) + 1);
    if (albumKey) albumUses.set(albumKey, (albumUses.get(albumKey) || 0) + 1);
    if (isFresh) freshIds.add(id);
    picked.push(item);
    return true;
  };
  pools.forEach((pool, index) => {
    let took = 0;
    for (const item of pool) {
      if (took >= DAILY_QUOTAS[slot][index] || picked.length >= DAILY_SIZE) break;
      if (add(item, true, index === 3)) took++;
    }
  });
  pools.forEach((pool, index) => {
    for (const item of pool) {
      if (picked.length >= DAILY_SIZE) break;
      add(item, false, index === 3);
    }
  });
  const tracks = shuffled(picked, seededRandom(host.crypto.md5(key))).map(toTrack);
  // Mornings open with songs the listener knows; by evening a new song should
  // have found its way into the opening.
  if (slot === "morning") {
    for (let index = 0; index < Math.min(DAILY_FAMILIAR_OPENING, tracks.length); index++) {
      if (!freshIds.has(tracks[index].id)) continue;
      const familiar = tracks.findIndex((track, at) => at >= DAILY_FAMILIAR_OPENING && !freshIds.has(track.id));
      if (familiar < 0) break;
      [tracks[index], tracks[familiar]] = [tracks[familiar], tracks[index]];
    }
  } else if (slot === "evening") {
    const opening = tracks.slice(0, DAILY_FAMILIAR_OPENING);
    if (opening.length && !opening.some((track) => freshIds.has(track.id))) {
      const freshAt = tracks.findIndex((track, at) => at >= DAILY_FAMILIAR_OPENING && freshIds.has(track.id));
      if (freshAt >= 0) {
        const last = DAILY_FAMILIAR_OPENING - 1;
        [tracks[last], tracks[freshAt]] = [tracks[freshAt], tracks[last]];
      }
    }
  }
  // A song with a cover leads the list, since the first row shows it best. A
  // morning keeps to a familiar one so its opening stays the familiar songs.
  let covered = -1;
  if (slot === "morning") {
    covered = tracks.findIndex((track) => track.album && track.album.imageUrl && !freshIds.has(track.id));
  }
  if (covered < 0) covered = tracks.findIndex((track) => track.album && track.album.imageUrl);
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
  // Each row of Home shows the same number of items before its See All.
  const preview = 12;
  const [daily, likedTracksData, newest, favoriteAlbumData, followedArtistData] = await Promise.all([
    soft(dailyTracks(), []),
    soft(items({ IncludeItemTypes: "Audio", Filters: "IsFavorite", SortBy: "DatePlayed", SortOrder: "Descending", Limit: preview }), { Items: [] }),
    soft(items({ IncludeItemTypes: "MusicAlbum", SortBy: "DateCreated", SortOrder: "Descending", Limit: preview }), { Items: [] }),
    soft(items({ IncludeItemTypes: "MusicAlbum", Filters: "IsFavorite", SortBy: "DateCreated", SortOrder: "Descending", Limit: preview }), { Items: [] }),
    soft(items({ IncludeItemTypes: "MusicArtist", Filters: "IsFavorite", SortBy: "SortName", Limit: preview }), { Items: [] }),
  ]);
  const sections = [];
  // No morePage: the card opens the section's own page, headed with the day
  // over the first cover's colors and the date. The subtitle follows the song
  // count there, keeping the time of day.
  if (daily.length) {
    sections.push({
      title: t("Daily Mix"),
      pageTitle: t("Daily Mix"),
      subtitle: slotLabel(slotOf(), lang()),
      tracks: daily,
    });
  }
  const albums = itemsOf(newest).map(toAlbum);
  if (albums.length) sections.push({ title: t("Recently Added"), albums, morePage: "recent" });
  const likedTracks = itemsOf(likedTracksData).map(toTrack);
  if (likedTracks.length) sections.push({ title: t("Favorite Songs"), tracks: likedTracks, morePage: "favorites" });
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

const SLOT_PLAYS_MAX = 500;

function slotPlays() {
  try {
    const counts = JSON.parse(store.get("slotPlays", ""));
    return counts && typeof counts === "object" ? counts : {};
  } catch {
    return {};
  }
}

// rememberSlotPlay counts each song's plays by the time of day they happened,
// so the mix can later learn what suits a morning or an evening. Nothing reads
// these counts yet.
function rememberSlotPlay(id) {
  const counts = slotPlays();
  const entry = counts[id] && typeof counts[id] === "object" ? counts[id] : {};
  const slot = slotOf();
  entry[slot] = (Number(entry[slot]) || 0) + 1;
  counts[id] = entry;
  const ids = Object.keys(counts);
  for (const old of ids.slice(0, Math.max(0, ids.length - SLOT_PLAYS_MAX))) delete counts[old];
  store.set("slotPlays", JSON.stringify(counts));
}

// played tells Emby the song played, so its play count and the day it last
// played move without it streaming the audio itself.
export async function played({ id }) {
  const current = token();
  const userId = currentUserId();
  if (!current || !userId || !id) return;
  rememberSlotPlay(String(id));
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

// ---------------------------------------------------------------------------
// Lyrics

// LRCLIB has synced lyrics for most tracks, Vkeys covers many Chinese songs
// it misses, and lrcmux is the last resort.
const LYRICS_SOURCES = [
  { name: "lrclib", find: lrclibLyrics },
  { name: "vkeys", find: vkeysLyrics },
  { name: "lrcmux", find: lrcmuxLyrics },
];
const LYRICS_AGENT = "MyGo Music Emby plugin/0.3.0 (https://github.com/moewah/mygo-music-emby)";
const LYRICS_TIMEOUT = 5000;
const LYRICS_DEADLINE = 20000;
const LYRICS_MAX = 300;
const LYRICS_VERSION = 2;
const LYRICS_TTL = 30 * 24 * 60 * 60 * 1000;
const LYRICS_MISS_TTL = 3 * 24 * 60 * 60 * 1000;

// Traditional to simplified character pairs, from OpenCC's TSCharacters.txt
// and TWVariants.txt (https://github.com/BYVoid/OpenCC, Apache-2.0). Providers
// list songs in simplified characters, while some libraries keep the
// traditional ones.
const SIMPLIFIED_PAIRS =
  "丟丢並并么幺乾干亂乱亙亘亞亚佇伫佈布佔占併并來来侖仑侶侣侷局俁俣係系俔伣俠侠俥伡俬私倀伥倆俩倈俫倉仓個个們们倖幸倫伦偉伟側侧偵侦偽伪傑杰傖伧傘伞備备傢家傭佣傯偬傳传傴伛債债傷伤傾倾僂偻僅仅僉佥僑侨僕仆僞伪僥侥僨偾僱雇價价儀仪儁俊儂侬億亿儈侩儉俭儎傤儐傧儔俦儕侪儘尽償偿優优儲储儷俪儺傩儻傥儼俨兇凶兌兑兒儿兗兖內内兩两冊册冑胄冪幂凈净凍冻凜凛凱凯別别刪删剄刭則则剋克剎刹剗刬剛刚剝剥剮剐剴剀創创剷铲劃划劄札劇剧劉刘劊刽劌刿劍剑劑剂勁劲動动務务勛勋勝胜勞劳勢势勩勚勱劢勳勋勵励勸劝勻匀匭匦匯汇匱匮區区協协卹恤卻却卽即厙厍厠厕厤历厭厌厲厉厴厣參参叄叁叢丛吒咤吳吴吶呐呂吕咼呙員员唄呗唸念問问啓启啞哑啟启啢唡喚唤喪丧喫吃喬乔單单喲哟嗆呛嗇啬嗊唝嗎吗嗚呜嗩唢嗶哔嘆叹嘍喽嘓啯嘔呕嘖啧嘗尝嘜唛嘩哗嘮唠嘯啸嘰叽嘵哓嘸呒嘽啴噁恶噓嘘噝咝噠哒噥哝噦哕噯嗳噲哙噴喷噸吨噹当嚀咛嚇吓嚌哜嚐尝嚕噜嚙啮嚥咽嚦呖嚨咙嚮向嚲亸嚳喾" +
  "嚴严嚶嘤囀啭囁嗫囂嚣囅冁囈呓囉啰囌苏囑嘱囪囱圇囵國国圍围園园圓圆圖图團团垻坝埡垭埰采執执堅坚堊垩堖垴堝埚堯尧報报場场塊块塋茔塏垲塒埘塗涂塚冢塢坞塤埙塵尘塹堑墊垫墜坠墮堕墰坛墳坟墶垯墻墙墾垦壇坛壋垱壎埙壓压壘垒壙圹壚垆壜坛壞坏壟垄壠垅壢坜壩坝壪塆壯壮壺壶壼壸壽寿夠够夢梦夥伙夾夹奐奂奧奥奩奁奪夺奬奖奮奋奼姹妝妆姍姗姦奸娛娱婁娄婦妇婭娅媧娲媯妫媼媪媽妈嫋袅嫗妪嫵妩嫺娴嫻娴嫿婳嬀妫嬃媭嬈娆嬋婵嬌娇嬙嫱嬡嫒嬤嬷嬪嫔嬰婴嬸婶孃娘孌娈孫孙學学孿孪宮宫寀采寢寝實实寧宁審审寫写寬宽寵宠寶宝將将專专尋寻對对導导尷尴屆届屍尸屓屃屜屉屢屡層层屨屦屬属岡冈峯峰峴岘島岛峽峡崍崃崑昆崗岗崙仑崢峥崬岽嵐岚嵗岁嶁嵝嶄崭嶇岖嶔嵚嶗崂嶠峤嶢峣嶧峄嶨峃嶮崄嶸嵘嶺岭嶼屿嶽岳巋岿巒峦巔巅巖岩巰巯巹卺帥帅師师帳帐帶带幀帧幃帏幗帼幘帻幟帜幣币幫帮幬帱幷并幹干幾几庫库廁厕廂厢廄厩廈厦廎庼廕荫廚厨廝厮廟庙廠厂廡庑廢废廣广廩廪廬庐廳厅弒弑弔吊" +
  "弳弪張张強强彆别彈弹彌弥彎弯彔录彙汇彠彟彥彦彫雕彲彨彿佛後后徑径從从徠徕復复徵征徹彻恆恒恥耻悅悦悞悮悵怅悶闷悽凄惡恶惱恼惲恽惻恻愛爱愜惬愨悫愴怆愷恺愾忾慄栗態态慍愠慘惨慚惭慟恸慣惯慤悫慪怄慫怂慮虑慳悭慶庆慼戚慾欲憂忧憊惫憐怜憑凭憒愦憖慭憚惮憤愤憫悯憮怃憲宪憶忆懇恳應应懌怿懍懔懞蒙懟怼懣懑懨恹懲惩懶懒懷怀懸悬懺忏懼惧懾慑戀恋戇戆戔戋戧戗戩戬戰战戱戯戲戏戶户扞捍拋抛拚拼挩捝挱挲挾挟捨舍捫扪捱挨捲卷掃扫掄抡掗挜掙挣掛挂採采揀拣揚扬換换揮挥揯搄損损搖摇搗捣搧扇搵揾搶抢摑掴摜掼摟搂摯挚摳抠摶抟摺折摻掺撈捞撏挦撐撑撓挠撟挢撣掸撥拨撫抚撲扑撳揿撻挞撾挝撿捡擁拥擄掳擇择擊击擋挡擔担據据擠挤擡抬擣捣擬拟擯摈擰拧擱搁擲掷擴扩擷撷擺摆擻擞擼撸擾扰攄摅攆撵攏拢攔拦攖撄攙搀攛撺攜携攝摄攢攒攣挛攤摊攪搅攬揽敎教敓敚敗败敘叙敵敌數数斂敛斃毙斆敩斕斓斬斩斷断於于旂旗旣既昇升時时晉晋晝昼暈晕暉晖暘旸暢畅暫暂曄晔曆历曇昙曉晓" +
  "曏向曖暧曠旷曨昽曬晒書书會会朧胧朮术東东枴拐柵栅柺拐査查桿杆梔栀梘枧條条梟枭梲棁棄弃棊棋棖枨棗枣棟栋棧栈棲栖棶梾椏桠楊杨楓枫楨桢業业極极榘矩榦干榪杩榮荣榲榅榿桤構构槍枪槓杠槤梿槧椠槨椁槮椮槳桨槶椢槼椝樁桩樂乐樅枞樑梁樓楼標标樞枢樣样樧榝樳桪樸朴樹树樺桦樿椫橈桡橋桥機机橢椭橫横檁檩檉柽檔档檜桧檟槚檢检檣樯檮梼檯台檳槟檸柠檻槛櫃柜櫓橹櫚榈櫛栉櫝椟櫞橼櫟栎櫥橱櫧槠櫨栌櫪枥櫫橥櫬榇櫱蘖櫳栊櫸榉櫻樱欄栏欅榉權权欏椤欒栾欖榄欞棂欽钦歎叹歐欧歟欤歡欢歲岁歷历歸归歿殁殘残殞殒殤殇殫殚殭僵殮殓殯殡殲歼殺杀殻壳殼壳毀毁毆殴毿毵氂牦氈毡氌氇氣气氫氢氬氩氳氲氾泛汎泛汙污決决沒没沖冲況况泝溯洩泄洶汹浹浃涇泾涗涚涼凉淒凄淚泪淥渌淨净淩凌淪沦淵渊淶涞淺浅渙涣減减渢沨渦涡測测渾浑湊凑湞浈湧涌湯汤溈沩準准溝沟溫温溮浉溳涢溼湿滄沧滅灭滌涤滎荥滙汇滬沪滯滞滲渗滷卤滸浒滻浐滾滚滿满漁渔漊溇漚沤漢汉漣涟漬渍漲涨漵溆漸渐漿浆潀潨潁颍" +
  "潑泼潔洁潙沩潛潜潤润潯浔潰溃潷滗潿涠澀涩澆浇澇涝澐沄澗涧澠渑澤泽澦滪澩泶澮浍澱淀濁浊濃浓濕湿濘泞濚溁濛蒙濜浕濟济濤涛濫滥濰潍濱滨濺溅濼泺濾滤瀂澛瀅滢瀆渎瀉泻瀋沈瀏浏瀕濒瀘泸瀝沥瀟潇瀠潆瀦潴瀧泷瀨濑瀰弥瀲潋瀾澜灃沣灄滠灑洒灕漓灘滩灝灏灣湾灤滦灧滟灩滟災灾為为烏乌烴烃無无煉炼煒炜煙烟煢茕煥焕煩烦煬炀熅煴熒荧熗炝熱热熲颎熾炽燁烨燈灯燉炖燒烧燙烫燜焖營营燦灿燬毁燭烛燴烩燻熏燼烬燾焘爍烁爐炉爛烂爭争爲为爺爷爾尔牀床牆墙牘牍牴抵牽牵犖荦犛牦犢犊犧牺狀状狹狭狽狈猙狰猶犹猻狲獁犸獃呆獄狱獅狮獎奖獨独獪狯獫猃獮狝獰狞獲获獵猎獷犷獸兽獺獭獻献獼猕玀猡現现琱雕琺珐琿珲瑋玮瑒玚瑣琐瑤瑶瑩莹瑪玛瑲玱璉琏璡琎璣玑璦瑷璫珰環环璵玙璸瑸璽玺璿璇瓊琼瓏珑瓔璎瓚瓒甌瓯甕瓮產产産产畝亩畢毕畫画異异畵画當当疇畴疊叠痙痉痠酸痺痹痾疴瘂痖瘋疯瘍疡瘓痪瘞瘗瘡疮瘧疟瘮瘆瘲疭瘺瘘瘻瘘療疗癆痨癇痫癉瘅癒愈癘疠癟瘪癡痴癢痒癤疖癥症癧疬癩癞癬癣" +
  "癭瘿癮瘾癰痈癱瘫癲癫發发皁皂皚皑皰疱皸皲皺皱盃杯盜盗盞盏盡尽監监盤盘盧卢盪荡眞真眥眦眾众睏困睜睁睞睐睪睾瞘眍瞞瞒瞶瞆瞼睑矇蒙矓眬矚瞩矯矫硃朱硜硁硤硖硨砗硯砚碕埼碩硕碭砀碸砜確确碼码磑硙磚砖磠硵磣碜磧碛磯矶磽硗礄硚礎础礙碍礦矿礪砺礫砾礬矾礱砻祕秘祿禄禍祸禎祯禕祎禡祃禦御禪禅禮礼禰祢禱祷禿秃秈籼稅税稈秆稜棱稟禀種种稱称穀谷穌稣積积穎颖穠秾穡穑穢秽穩稳穫获穭穞窩窝窪洼窮穷窯窑窵窎窶窭窺窥竄窜竅窍竇窦竈灶竊窃竪竖競竞筆笔筍笋筧笕箇个箋笺箏筝箚札節节範范築筑篋箧篔筼篠筿篤笃篩筛篳筚簀箦簍篓簑蓑簞箪簡简簣篑簫箫簷檐簹筜簽签簾帘籃篮籌筹籙箓籛篯籜箨籟籁籠笼籤签籩笾籪簖籬篱籮箩籲吁粵粤糉粽糝糁糞粪糧粮糰团糲粝糴籴糶粜糹纟糾纠紀纪紂纣約约紅红紆纡紇纥紈纨紉纫紋纹納纳紐纽紓纾純纯紕纰紖纼紗纱紘纮紙纸級级紛纷紜纭紝纴紡纺紮扎細细紱绂紲绁紳绅紵纻紹绍紺绀紼绋紿绐絀绌終终絃弦組组絆绊絎绗結结絕绝絛绦絝绔絞绞絡络絢绚" +
  "給给絨绒絰绖統统絲丝絳绛絶绝絹绢綁绑綃绡綆绠綈绨綉绣綌绤綏绥綑捆經经綜综綞缍綠绿綢绸綣绻綫线綬绶維维綯绹綰绾綱纲網网綳绷綴缀綵彩綸纶綹绺綺绮綻绽綽绰綾绫綿绵緄绲緇缁緊紧緋绯緑绿緒绪緓绬緔绱緗缃緘缄緙缂線线緝缉緞缎締缔緡缗緣缘緦缌編编緩缓緬缅緯纬緱缑緲缈練练緶缏緹缇緻致緼缊縈萦縉缙縊缢縋缒縐绉縑缣縕缊縗缞縛缚縝缜縞缟縟缛縣县縧绦縫缝縭缡縮缩縱纵縲缧縴纤縵缦縶絷縷缕縹缥總总績绩繃绷繅缫繆缪繒缯織织繕缮繚缭繞绕繡绣繢缋繩绳繪绘繫系繭茧繮缰繯缳繰缲繳缴繹绎繼继繽缤繾缱纇颣纈缬纊纩續续纍累纏缠纓缨纔才纖纤纘缵纜缆缽钵罈坛罌罂罎坛罰罚罵骂罷罢羅罗羆罴羈羁羋芈羣群羥羟羨羡義义羶膻習习翫玩翬翚翹翘翽翙耬耧耮耢聖圣聞闻聯联聰聪聲声聳耸聵聩聶聂職职聹聍聽听聾聋肅肃脅胁脈脉脛胫脣唇脩修脫脱脹胀腎肾腖胨腡脶腦脑腫肿腳脚腸肠膃腽膕腘膚肤膠胶膩腻膽胆膾脍膿脓臉脸臍脐臏膑臘腊臚胪臟脏臠脔臢臜臥卧臨临臺台與与興兴舉举舊旧" +
  "舖铺舘馆艙舱艤舣艦舰艫舻艱艰艷艳芻刍苧苎茲兹荊荆莊庄莖茎莢荚莧苋華华菴庵菸烟萇苌萊莱萬万萴荝萵莴葉叶葒荭著着葤荮葦苇葯药葷荤蒍蔿蒐搜蒓莼蒔莳蒕蒀蒞莅蒼苍蓀荪蓆席蓋盖蓮莲蓯苁蓴莼蓽荜蔔卜蔘参蔞蒌蔣蒋蔥葱蔦茑蔭荫蕁荨蕆蒇蕎荞蕒荬蕓芸蕕莸蕘荛蕢蒉蕩荡蕪芜蕭萧蕷蓣薀蕰薈荟薊蓟薌芗薑姜薔蔷薘荙薟莶薦荐薩萨薴苧薹苔薺荠藍蓝藎荩藝艺藥药藪薮藴蕴藶苈藹蔼藺蔺蘀萚蘄蕲蘆芦蘇苏蘊蕴蘋苹蘚藓蘞蔹蘢茏蘭兰蘺蓠蘿萝虆蔂處处虛虚虜虏號号虧亏虯虬蛺蛱蛻蜕蜆蚬蝕蚀蝟猬蝦虾蝨虱蝸蜗螄蛳螞蚂螢萤螻蝼螿螀蟄蛰蟈蝈蟎螨蟣虮蟬蝉蟯蛲蟲虫蟶蛏蟻蚁蠁蚃蠅蝇蠆虿蠍蝎蠐蛴蠑蝾蠔蚝蠟蜡蠣蛎蠨蟏蠱蛊蠶蚕蠻蛮衆众衊蔑術术衕同衚胡衛卫衝冲袞衮袷夹裊袅裏里補补裝装裡里製制複复褌裈褘袆褲裤褳裢褸褛褻亵襇裥襉裥襏袯襖袄襝裣襠裆襤褴襪袜襬摆襯衬襲袭襴襕覈核見见覎觃規规覓觅視视覘觇覡觋覥觍覦觎親亲覬觊覯觏覲觐覷觑覺觉覽览覿觌觀观觴觞觶觯觸触訁讠訂订訃讣計计" +
  "訊讯訌讧討讨訐讦訒讱訓训訕讪訖讫託托記记訛讹訝讶訟讼訣诀訥讷訩讻訪访設设許许訴诉訶诃診诊註注証证詁诂詆诋詎讵詐诈詒诒詔诏評评詖诐詗诇詘诎詛诅詞词詠咏詡诩詢询詣诣試试詩诗詫诧詬诟詭诡詮诠詰诘話话該该詳详詵诜詼诙詿诖誄诔誅诛誆诓誇夸誌志認认誑诳誒诶誕诞誘诱誚诮語语誠诚誡诫誣诬誤误誥诰誦诵誨诲說说説说誰谁課课誶谇誹诽誼谊誾訚調调諂谄諄谆談谈諉诿請请諍诤諏诹諑诼諒谅論论諗谂諛谀諜谍諝谞諞谝諡谥諢诨諤谔諦谛諧谐諫谏諭谕諮咨諱讳諳谙諶谌諷讽諸诸諺谚諼谖諾诺謀谋謁谒謂谓謄誊謅诌謊谎謎谜謐谧謔谑謖谡謗谤謙谦謚谥講讲謝谢謠谣謡谣謨谟謫谪謬谬謭谫謳讴謹谨謾谩譁哗證证譎谲譏讥譖谮識识譙谯譚谭譜谱譟噪譫谵譭毁譯译議议譴谴護护譸诪譽誉譾谫讀读讅谉變变讋詟讎雠讒谗讓让讕谰讖谶讚赞讜谠讞谳谿溪豈岂豎竖豐丰豔艳豬猪豶豮貍狸貓猫貝贝貞贞貟贠負负財财貢贡貧贫貨货販贩貪贪貫贯責责貯贮貰贳貲赀貳贰貴贵貶贬買买貸贷貺贶費费貼贴貽贻" +
  "貿贸賀贺賁贲賂赂賃赁賄贿賅赅資资賈贾賊贼賑赈賒赊賓宾賕赇賙赒賚赉賜赐賞赏賠赔賡赓賢贤賣卖賤贱賦赋賧赕質质賫赍賬账賭赌賴赖賵赗賺赚賻赙購购賽赛賾赜贄贽贅赘贇赟贈赠贊赞贋赝贍赡贏赢贐赆贓赃贔赑贖赎贗赝贛赣贜赃赬赪趕赶趙赵趨趋趲趱跡迹踐践踰逾踴踊蹌跄蹕跸蹟迹蹠跖蹣蹒蹤踪蹺跷躂跶躉趸躊踌躋跻躍跃躑踯躒跞躓踬躕蹰躚跹躡蹑躥蹿躦躜躪躏軀躯車车軋轧軌轨軍军軑轪軒轩軔轫軛轭軟软軤轷軫轸軲轱軸轴軹轵軺轺軻轲軼轶軾轼較较輅辂輇辁輈辀載载輊轾輒辄輓挽輔辅輕轻輛辆輜辎輝辉輞辋輟辍輥辊輦辇輩辈輪轮輬辌輯辑輳辏輸输輻辐輼辒輾辗輿舆轀辒轂毂轄辖轅辕轆辘轉转轍辙轎轿轔辚轟轰轡辔轢轹轤轳辦办辭辞辮辫辯辩農农迴回逕径這这連连週周進进遊游運运過过達达違违遙遥遜逊遞递遠远遡溯適适遲迟遶绕遷迁選选遺遗遼辽邁迈還还邇迩邊边邏逻邐逦郟郏郵邮鄆郓鄉乡鄒邹鄔邬鄖郧鄧邓鄭郑鄰邻鄲郸鄴邺鄶郐鄺邝酇酂酈郦醃腌醖酝醜丑醞酝醟蒏醣糖醫医醬酱醱酦釀酿" +
  "釁衅釃酾釅酽釋释釐厘釒钅釓钆釔钇釕钌釗钊釘钉釙钋針针釣钓釤钐釦扣釧钏釩钒釵钗釷钍釹钕釺钎鈀钯鈁钫鈃钘鈄钭鈅钥鈈钚鈉钠鈍钝鈎钩鈐钤鈑钣鈒钑鈔钞鈕钮鈞钧鈡钟鈣钙鈥钬鈦钛鈧钪鈮铌鈰铈鈳钶鈴铃鈷钴鈸钹鈹铍鈺钰鈽钸鈾铀鈿钿鉀钾鉅巨鉆钻鉈铊鉉铉鉋铇鉍铋鉑铂鉕钷鉗钳鉚铆鉛铅鉞钺鉢钵鉤钩鉦钲鉬钼鉭钽鉳锫鉶铏鉸铰鉺铒鉻铬鉿铪銀银銃铳銅铜銍铚銑铣銓铨銖铢銘铭銚铫銛铦銜衔銠铑銣铷銥铱銦铟銨铵銩铥銪铕銫铯銬铐銱铞銳锐銷销銹锈銻锑銼锉鋁铝鋃锒鋅锌鋇钡鋌铤鋏铗鋒锋鋙铻鋝锊鋟锓鋣铘鋤锄鋥锃鋦锔鋨锇鋩铓鋪铺鋭锐鋮铖鋯锆鋰锂鋱铽鋶锍鋸锯鋼钢錁锞錄录錆锖錇锫錈锩錏铔錐锥錒锕錕锟錘锤錙锱錚铮錛锛錟锬錠锭錡锜錢钱錦锦錨锚錩锠錫锡錮锢錯错録录錳锰錶表錸铼錼镎鍀锝鍁锨鍃锪鍅钫鍆钔鍇锴鍈锳鍊炼鍋锅鍍镀鍔锷鍘铡鍚钖鍛锻鍠锽鍤锸鍥锲鍩锘鍬锹鍰锾鍵键鍶锶鍺锗鍼针鍾钟鎂镁鎄锿鎇镅鎊镑鎌镰鎔镕鎖锁鎘镉鎚锤鎛镈鎡镃鎢钨鎣蓥鎦镏鎧铠鎩铩鎪锼鎬镐鎭镇" +
  "鎮镇鎰镒鎲镋鎳镍鎵镓鎶鿔鎸镌鎿镎鏃镞鏇旋鏈链鏌镆鏍镙鏐镠鏑镝鏗铿鏘锵鏜镗鏝镘鏞镛鏟铲鏡镜鏢镖鏤镂鏨錾鏰镚鏵铧鏷镤鏹镪鏽锈鐃铙鐋铴鐐镣鐒铹鐓镦鐔镡鐘钟鐙镫鐝镢鐠镨鐦锎鐧锏鐨镄鐫镌鐮镰鐲镯鐳镭鐵铁鐶镮鐸铎鐺铛鐿镱鑄铸鑊镬鑌镔鑑鉴鑒鉴鑔镲鑕锧鑞镴鑠铄鑣镳鑥镥鑭镧鑰钥鑱镵鑲镶鑷镊鑹镩鑼锣鑽钻鑾銮鑿凿钁镢钂镋長长門门閂闩閃闪閆闫閈闬閉闭開开閌闶閎闳閏闰閑闲閒闲間间閔闵閘闸閡阂閣阁閤合閥阀閨闺閩闽閫阃閬阆閭闾閱阅閲阅閶阊閹阉閻阎閼阏閽阍閾阈閿阌闃阒闆板闇暗闈闱闊阔闋阕闌阑闍阇闐阗闒阘闓闿闔阖闕阙闖闯關关闞阚闠阓闡阐闢辟闤阛闥闼陘陉陝陕陞升陣阵陰阴陳陈陸陆陽阳隉陧隊队階阶隕陨際际隨随險险隯陦隱隐隴陇隸隶隻只雋隽雖虽雙双雛雏雜杂雞鸡離离難难雲云電电霑沾霢霡霧雾霽霁靂雳靄霭靆叇靈灵靉叆靚靓靜静靝靔靦腼靨靥鞏巩鞝绱鞦秋鞽鞒韁缰韃鞑韆千韉鞯韋韦韌韧韍韨韓韩韙韪韜韬韝鞲韞韫韻韵響响頁页頂顶頃顷項项順顺頇顸須须頊顼" +
  "頌颂頎颀頏颃預预頑顽頒颁頓顿頗颇領领頜颌頡颉頤颐頦颏頭头頮颒頰颊頲颋頴颕頷颔頸颈頹颓頻频頽颓顆颗題题額额顎颚顏颜顒颙顓颛顔颜願愿顙颡顛颠類类顢颟顥颢顧顾顫颤顬颥顯显顰颦顱颅顳颞顴颧風风颭飐颮飑颯飒颱台颳刮颶飓颸飔颺飏颻飖颼飕飀飗飄飘飆飙飈飚飛飞飠饣飢饥飣饤飥饦飩饨飪饪飫饫飭饬飯饭飱飧飲饮飴饴飼饲飽饱飾饰飿饳餃饺餄饸餅饼餈糍餉饷養养餌饵餎饹餏饻餑饽餒馁餓饿餕馂餖饾餘余餚肴餛馄餜馃餞饯餡馅館馆餬糊餱糇餳饧餵喂餶馉餷馇餺馎餼饩餾馏餿馊饁馌饃馍饅馒饈馐饉馑饊馓饋馈饌馔饑饥饒饶饗飨饜餍饞馋饢馕馬马馭驭馮冯馱驮馳驰馴驯馹驲駁驳駐驻駑驽駒驹駔驵駕驾駘骀駙驸駛驶駝驼駟驷駡骂駢骈駭骇駰骃駱骆駸骎駿骏騁骋騂骍騅骓騌骔騍骒騎骑騏骐騖骛騙骗騤骙騫骞騭骘騮骝騰腾騶驺騷骚騸骟騾骡驀蓦驁骜驂骖驃骠驄骢驅驱驊骅驌骕驍骁驏骣驕骄驗验驚惊驛驿驟骤驢驴驤骧驥骥驦骦驪骊驫骉骯肮髏髅髒脏體体髕髌髖髋髮发鬆松鬍胡鬚须鬢鬓鬥斗鬧闹鬨哄" +
  "鬩阋鬮阄鬱郁鬹鬶魎魉魘魇魚鱼魛鱽魢鱾魨鲀魯鲁魴鲂魷鱿魺鲄鮁鲅鮃鲆鮊鲌鮋鲉鮍鲏鮎鲇鮐鲐鮑鲍鮒鲋鮓鲊鮚鲒鮜鲘鮝鲞鮞鲕鮦鲖鮪鲔鮫鲛鮭鲑鮮鲜鮳鲓鮶鲪鮺鲝鯀鲧鯁鲠鯇鲩鯉鲤鯊鲨鯒鲬鯔鲻鯕鲯鯖鲭鯗鲞鯛鲷鯝鲴鯡鲱鯢鲵鯤鲲鯧鲳鯨鲸鯪鲮鯫鲰鯰鲶鯴鲺鯷鳀鯽鲫鯿鳊鰁鳈鰂鲗鰃鳂鰈鲽鰉鳇鰍鳅鰏鲾鰐鳄鰒鳆鰓鳃鰛鳁鰜鳒鰟鳑鰠鳋鰣鲥鰥鳏鰨鳎鰩鳐鰭鳍鰮鳁鰱鲢鰲鳌鰳鳓鰵鳘鰷鲦鰹鲣鰺鲹鰻鳗鰼鳛鰾鳔鱂鳉鱅鳙鱈鳕鱉鳖鱒鳟鱔鳝鱖鳜鱗鳞鱘鲟鱝鲼鱟鲎鱠鲙鱣鳣鱤鳡鱧鳢鱨鲿鱭鲚鱯鳠鱷鳄鱸鲈鱺鲡鳥鸟鳧凫鳩鸠鳬凫鳲鸤鳳凤鳴鸣鳶鸢鴆鸩鴇鸨鴉鸦鴒鸰鴕鸵鴛鸳鴝鸲鴞鸮鴟鸱鴣鸪鴦鸯鴨鸭鴯鸸鴰鸹鴴鸻鴻鸿鴿鸽鵂鸺鵃鸼鵐鹀鵑鹃鵒鹆鵓鹁鵜鹈鵝鹅鵠鹄鵡鹉鵪鹌鵬鹏鵮鹐鵯鹎鵰雕鵲鹊鵷鹓鵾鹍鶇鸫鶉鹑鶊鹒鶓鹋鶖鹙鶘鹕鶚鹗鶡鹖鶥鹛鶩鹜鶬鸧鶯莺鶲鹟鶴鹤鶹鹠鶺鹡鶻鹘鶼鹣鶿鹚鷀鹚鷁鹢鷂鹞鷄鸡鷊鹝鷓鹧鷖鹥鷗鸥鷙鸷鷚鹨鷥鸶鷦鹪鷫鹔鷯鹩鷲鹫鷳鹇鷴鹇鷸鹬鷹鹰鷺鹭鷽鸴鸇鹯鸌鹱鸏鹲鸕鸬鸘鹴鸚鹦" +
  "鸛鹳鸝鹂鸞鸾鹵卤鹹咸鹺鹾鹼碱鹽盐麗丽麥麦麩麸麪面麫面麯曲麴曲麵面麼么麽么黃黄黌黉點点黨党黲黪黴霉黶黡黷黩黽黾黿鼋鼂鼌鼉鼍鼕冬鼴鼹齊齐齋斋齎赍齏齑齒齿齔龀齕龁齗龂齙龅齜龇齟龃齠龆齡龄齣出齦龈齧啮齪龊齬龉齲龋齶腭齷龌龍龙龎厐龐庞龔龚龕龛龜龟鿓鿒";

const SIMPLIFIED = (() => {
  const map = new Map();
  for (let i = 0; i < SIMPLIFIED_PAIRS.length; i += 2) map.set(SIMPLIFIED_PAIRS[i], SIMPLIFIED_PAIRS[i + 1]);
  return map;
})();

function simplified(text) {
  let out = "";
  for (const char of String(text || "")) out += SIMPLIFIED.get(char) || char;
  return out;
}

// within rejects a request that takes longer than ms.
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// lyricsWait is how long a request may take: no more than LYRICS_TIMEOUT, and
// no longer than the chain has left of its deadline.
function lyricsWait(until) {
  return Math.min(LYRICS_TIMEOUT, until - Date.now());
}

async function lyricsResponse(url, until) {
  const wait = lyricsWait(until);
  if (wait <= 0) throw new Error("out of time");
  return within(
    fetch(url, { headers: { Accept: "application/json, text/plain", "User-Agent": LYRICS_AGENT } }),
    wait,
  );
}

async function lyricsJson(url, until) {
  const response = await lyricsResponse(url, until);
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function lyricsText(url, until) {
  const response = await lyricsResponse(url, until);
  if (!response.ok) return "";
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function timedLrc(text) {
  const lrc = typeof text === "string" ? text.trim() : "";
  return /\[\d{1,3}:\d{2}/.test(lrc) ? lrc : "";
}

function normalized(text) {
  return simplified(String(text || ""))
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\w\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, "");
}

// Vkeys gives a track's length as minutes and seconds, "4\u520629\u79d2".
function secondsOf(text) {
  const match = /(?:(\d+)\s*\u5206)?\s*(\d+)\s*\u79d2/.exec(String(text || ""));
  return match ? Number(match[1] || 0) * 60 + Number(match[2]) : 0;
}

// The closest match wins: title, artist and length.
function lyricsScore(candidate, info) {
  let score = 0;
  const title = normalized(pick(candidate, "trackName", ""));
  const wanted = normalized(info.title);
  if (title && title === wanted) score += 4;
  else if (title && wanted && (title.includes(wanted) || wanted.includes(title))) score += 2;
  const artist = normalized(pick(candidate, "artistName", ""));
  const wantedArtists = [info.artist, info.firstArtist].map(normalized).filter(Boolean);
  if (artist && wantedArtists.some((name) => artist.includes(name) || name.includes(artist))) score += 3;
  if (info.duration) {
    const gap = Math.abs((Number(pick(candidate, "duration", 0)) || 0) - info.duration);
    if (gap <= 2) score += 3;
    else if (gap <= 5) score += 2;
    else if (gap <= 10) score += 1;
  }
  return score;
}

async function lrclibSearch(trackName, artistName, until) {
  const found = await lyricsJson(`https://lrclib.net/api/search${queryString({
    track_name: trackName,
    artist_name: artistName,
  })}`, until);
  return Array.isArray(found) ? found : [];
}

// bestLrc picks the closest candidate that comes with timed lyrics.
function bestLrc(candidates, info) {
  let best = "";
  let bestScore = 0;
  for (const candidate of candidates) {
    const lrc = timedLrc(pick(candidate, "syncedLyrics", ""));
    if (!lrc) continue;
    const score = lyricsScore(candidate, info);
    if (score > bestScore) {
      best = lrc;
      bestScore = score;
    }
  }
  return bestScore >= 5 ? best : "";
}

async function lrclibLyrics(info, until) {
  // A request that fails or runs out of time leaves the rest of the source
  // worth trying: the search is quicker than the exact lookup, and often has
  // what the lookup was too slow to answer.
  let unsure = false;
  const attempt = async (step) => {
    try {
      return await step();
    } catch {
      unsure = true;
      return null;
    }
  };
  const exact = await attempt(() =>
    lyricsJson(`https://lrclib.net/api/get${queryString({
      track_name: info.title,
      artist_name: info.artist,
      album_name: info.album,
      duration: info.duration || undefined,
    })}`, until),
  );
  if (exact && pick(exact, "instrumental", false)) return "";
  const exactLrc = timedLrc(pick(exact || {}, "syncedLyrics", ""));
  if (exactLrc) return exactLrc;
  const title = info.title;
  const artist = info.firstArtist || info.artist;
  const lrc = bestLrc((await attempt(() => lrclibSearch(title, artist, until))) || [], info);
  if (lrc) return lrc;
  // A library catalogued in traditional characters finds nothing above.
  const simpleTitle = simplified(title);
  const simpleArtist = simplified(artist);
  if (simpleTitle === title && simpleArtist === artist) return unsure ? null : "";
  const simpleLrc = bestLrc((await attempt(() => lrclibSearch(simpleTitle, simpleArtist, until))) || [], info);
  if (simpleLrc) return simpleLrc;
  return unsure ? null : "";
}

async function vkeysLyrics(info, until) {
  let search;
  try {
    search = await lyricsJson(`https://api.vkeys.cn/v2/music/tencent/search/song${queryString({
      word: [info.title, info.firstArtist || info.artist].filter(Boolean).join(" "),
      num: 20,
    })}`, until);
  } catch {
    return null;
  }
  const results = pick(search || {}, "data", []);
  if (!Array.isArray(results) || !results.length) return "";
  let best = null;
  let bestScore = 0;
  for (const candidate of results) {
    const score = lyricsScore({
      trackName: pick(candidate, "song", ""),
      artistName: pick(candidate, "singer", ""),
      duration: secondsOf(pick(candidate, "interval", "")),
    }, info);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (!best || bestScore < 5) return "";
  let lyric;
  try {
    lyric = await lyricsJson(`https://api.vkeys.cn/v2/music/tencent/lyric${queryString({
      id: pick(best, "id", undefined) || pick(best, "mid", undefined),
    })}`, until);
  } catch {
    return null;
  }
  return timedLrc(pick(pick(lyric || {}, "data", {}) || {}, "lrc", ""));
}

async function lrcmuxLyrics(info, until) {
  const fetchLrc = async (title, artist, album) => {
    const text = await lyricsText(`https://api.lrcmux.dev/get${queryString({
      artist,
      title,
      album,
      duration: info.duration || undefined,
      level: "line",
      strict: "true",
      format: "lrc",
    })}`, until);
    return timedLrc(text);
  };
  const artist = info.firstArtist || info.artist;
  const lrc = await fetchLrc(info.title, artist, info.album);
  if (lrc) return lrc;
  const simpleTitle = simplified(info.title);
  const simpleArtist = simplified(artist);
  if (simpleTitle === info.title && simpleArtist === artist) return "";
  return fetchLrc(simpleTitle, simpleArtist, simplified(info.album));
}

// findLyrics asks each source in turn. A source that can't answer in time says
// null, and the chain remembers that it was unsure: the words may be there on
// another try.
async function findLyrics(info) {
  const until = Date.now() + LYRICS_DEADLINE;
  let unsure = false;
  for (const source of LYRICS_SOURCES) {
    if (Date.now() >= until) {
      unsure = true;
      break;
    }
    try {
      const lrc = await source.find(info, until);
      if (lrc) return { lrc, source: source.name, unsure: false };
      if (lrc === null) unsure = true;
    } catch {
      unsure = true;
    }
  }
  return { lrc: "", source: "", unsure };
}

function lyricsKey(id) {
  return `lyrics:${id}`;
}

function lyricsCacheKeys() {
  try {
    const keys = JSON.parse(store.get("lyricsCacheKeys", "[]"));
    return Array.isArray(keys) ? keys : [];
  } catch {
    return [];
  }
}

function cachedLyrics(id) {
  let entry = null;
  try {
    entry = JSON.parse(store.get(lyricsKey(id), ""));
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object" || !entry.at || entry.version !== LYRICS_VERSION) {
    if (entry && typeof entry === "object") forgetLyrics(id);
    return null;
  }
  const ttl = entry.lrc ? LYRICS_TTL : LYRICS_MISS_TTL;
  if (Date.now() - entry.at > ttl) {
    forgetLyrics(id);
    return null;
  }
  return entry;
}

function rememberLyrics(id, lrc, source) {
  store.set(lyricsKey(id), JSON.stringify({ version: LYRICS_VERSION, lrc, source, at: Date.now() }));
  const keys = lyricsCacheKeys().filter((key) => key !== id);
  keys.unshift(id);
  for (const dropped of keys.splice(LYRICS_MAX)) store.remove(lyricsKey(dropped));
  store.set("lyricsCacheKeys", JSON.stringify(keys));
}

function forgetLyrics(id) {
  store.remove(lyricsKey(id));
  store.set("lyricsCacheKeys", JSON.stringify(lyricsCacheKeys().filter((key) => key !== id)));
}

function clearLyrics() {
  for (const id of lyricsCacheKeys()) store.remove(lyricsKey(id));
  store.remove("lyricsCacheKeys");
}

function lyricsInfo(item) {
  const artists = artistsOf(item);
  return {
    title: pick(item, "Name", ""),
    artist: artists.map((artist) => artist.name).join(", "),
    firstArtist: artists.length ? artists[0].name : "",
    album: pick(item, "Album", ""),
    duration: Math.round(durationOf(item) / 1000),
  };
}

// lyrics answers a track's words as LRC, from the first source that has them.
export async function lyrics({ id }) {
  requireSession();
  const cached = cachedLyrics(id);
  if (cached) return cached.lrc ? { lrc: cached.lrc } : {};
  let item;
  try {
    item = await itemById(id);
  } catch {
    return {};
  }
  const info = lyricsInfo(item);
  if (!info.title) return {};
  const found = await findLyrics(info);
  // Only a definite miss is remembered; one the sources couldn't answer is
  // asked again the next time the track plays.
  if (found.lrc || !found.unsure) rememberLyrics(id, found.lrc, found.source);
  return found.lrc ? { lrc: found.lrc } : {};
}
