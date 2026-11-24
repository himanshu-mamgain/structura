# Proximity Service (Nearby Places)

> 💡 **TL;DR**: A **proximity service** answers "what's near me?": restaurants within 2 km, the nearest cash machines. With 200 million places, scanning every row for each search is far too slow, and an ordinary database index can't search latitude and longitude ranges well together. The trick is a **geohash**: it cuts the map into labelled cells, and turns any point into a short string such as `ttnfv`. Points that share a beginning are close together. The service keeps a **list of place IDs per cell** in Redis, reads the user's cell and its **8 neighbours**, then measures the **true distance** to each candidate and keeps those inside the radius. Places change rarely, so the index is updated in the background through a queue.

## At a glance

| Question | Answer |
|---|---|
| The question | Which places are within a radius of this point? |
| Why not plain SQL | An index handles one range well, not latitude and longitude together |
| Geohash | A short string for a map cell; a longer string is a smaller cell |
| Shared prefix | Places whose geohashes start the same are close together |
| The index | For each cell, the set of place IDs in it, in Redis |
| A search reads | The user's cell and its 8 neighbours: 9 cells |
| Then | Measure the real distance to each candidate; keep those inside the radius |
| Picking the cell size | A cell at least as wide as the radius |
| Updates | Saved in the database, then the index is updated through a queue |
| Load in the example | About 5,800 searches a second; about 12 changes a second |

## What a proximity service is, and why it's hard

Apps like Google Maps, Swiggy or Yelp answer "near me" questions constantly. The input is the user's position (a **latitude**, how far north or south, and a **longitude**, how far east or west) and a radius. The output is the matching places, nearest first.

The obvious SQL is:

```sql
SELECT id FROM places
WHERE lat BETWEEN 28.61 AND 28.65 AND lon BETWEEN 77.19 AND 77.24;
```

An index on `lat` quickly finds the narrow band of latitude, but that band runs right around the world, through millions of places, and every one of them must then be checked for longitude. An index helps with one range at a time, not two together. With 200 million places and thousands of searches a second, that's too slow.

## What a geohash is

A **geohash** turns a point into a short string by repeatedly cutting the map in half: is it east or west of the middle? North or south? Each answer is one bit, and every 5 bits become one character from a 32-character alphabet.

Each extra character makes the cell smaller:

| Length | Cell size (about, at the equator) |
|---|---|
| 4 | 39 km × 20 km |
| 5 | 4.9 km × 4.9 km |
| 6 | 1.2 km × 0.6 km |

The key property: **a longer shared prefix means a closer pair of points**. Connaught Place in Delhi (28.6315, 77.2167) is `ttnf` at length 4, `ttnfv` at length 5 and `ttnfvh` at length 6. Anything else in cell `ttnfv` is within that 4.9 km square.

So "what's near me?" becomes "what's in my cell?", which is just a key lookup.

## Follow one search all the way through

Asha stands at Connaught Place and asks for cafés within 2 km.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | The app sends her position and 2 km | Client (Mobile App) → API Gateway |
| 2 | The search service picks length 5: its cells (4.9 km) are wider than the 2 km radius | Location Search Service |
| 3 | Her cell is `ttnfv`; it works out the 8 neighbouring cells around it | Location Search Service |
| 4 | It reads the place IDs in those 9 cells from Redis | Geohash Index (Redis) |
| 5 | A café at (28.6280, 77.2190), in her own cell: 0.45 km away, kept | Location Search Service |
| 6 | A place at (28.6560, 77.2400), in neighbour cell `ttngj`: 3.55 km away, outside 2 km, dropped | Location Search Service |
| 7 | The survivors are sorted nearest first | Location Search Service |
| 8 | Names, photos and ratings come from the cache, or the database on a miss | Business Service → Business Cache (Redis) → Business DB (primary + replicas) |
| 9 | The list goes back to the app | API Gateway → Client (Mobile App) |

Step 6 shows why the real distance check matters: a cell is a rectangle, so a neighbouring cell can contain places well outside the circle.

## Why 9 cells, not 1

Two shops a metre apart can sit on either side of a cell border, with completely different geohashes. If Asha stands near the edge of `ttnfv`, the nearest café might be just across the line in the next cell. Searching only her cell would miss it.

So the service always reads her cell **and its 8 neighbours** (above, below, left, right and the four corners). Together they cover every point within one cell-width of her, whatever side of a border she's on.

## The index, in Redis

The **Geohash Index** keeps, for every cell, a set of the place IDs inside it, at three lengths (4, 5 and 6), so any radius can use a suitable cell size:

```text
SADD geo:5:ttnfv b-1042 b-2210 b-3388
SMEMBERS geo:5:ttnfv      → b-1042, b-2210, b-3388
```

The search service reads the 9 sets, then computes the true distance to each place with the **haversine formula**, which gives the distance between two points on a sphere:

```javascript
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371 // Earth's radius in km
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLon = rad(lon2 - lon1)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

distanceKm(28.6315, 77.2167, 28.6280, 77.2190) // ≈ 0.45
distanceKm(28.6315, 77.2167, 28.6560, 77.2400) // ≈ 3.55
```

Redis also has built-in geo commands (`GEOADD`, `GEOSEARCH`) that use geohashes inside; knowing how they work lets you explain them.

## Updates: a few seconds' delay is fine

When an owner adds or moves a place, the change is saved in the **Business DB** and an event goes onto the **Update Queue**. The **Index Builder** reads it and adds or removes the ID in the right cells. A search might not see the change for a few seconds, which nobody notices, and saving a place never waits for the index.

## The numbers, worked out

- **Places**: 200 million.
- **Searches**: 100 million daily users × 5 searches = 500 million a day ÷ 86,400 s ≈ **5,800 a second**; plan for twice that at peak, about 11.6k.
- **Changes**: 1 million places edited a day ÷ 86,400 ≈ **12 a second**. Reads outnumber writes about **500 to 1**.
- **Place details**: 200 million × 1 KB = **200 GB**, fine for one database server with read replicas.
- **Index**: each place stored at 3 lengths × 8 bytes per ID = 200 million × 3 × 8 bytes = **4.8 GB**, small enough for one Redis server; copies are for read speed and safety.

## What it costs and where it stops

- **Dense cells**: a busy downtown cell can hold thousands of places. Use a longer geohash there, or split busy cells.
- **Cells are uneven**: they're squares in the middle of the map but thin slivers near the poles, and they wrap at the 180° line; handle those cases.
- **Storage triples** with 3 lengths in the index, but at 4.8 GB that's still small.
- **Sharding the details** by business ID, not by location, so one popular city doesn't overload one server.

## How to choose

- **Geohash cells in a key-value store?** Simple, works with Redis or any database, easy to split across servers. The usual answer.
- **Very uneven density?** A **quadtree**: a tree that splits a crowded area into 4 smaller squares and leaves empty areas as large squares. It adapts to density but lives in memory and must be rebuilt after a restart.
- **A database with spatial indexes** (PostGIS for Postgres)? Fine at moderate scale, and far less work.
- **Moving objects** (drivers)? Same cells, but updates every few seconds; see the Uber Surge topic.

## ⚠️ Critical Mistakes

- **Searching only the user's own cell.** Places just across a border are missed. Read the 8 neighbours too.
- **Returning everything in the cells.** Corners of a cell can be far outside the radius. Filter by true distance.
- **A cell much smaller than the radius.** You need dozens of cells per search. Pick a cell at least as wide as the radius.
- **Updating the index inside the owner's save request.** Writes slow down for no benefit. Update it through a queue.
- **Sharding place details by location.** One busy city overloads one server.

## Interview Q&As

**Q: Why can't you just index latitude and longitude?**

A: An index narrows one range quickly, but "latitude between a and b" is a band around the whole world; every place in that band must then be checked for longitude. Geohashes turn the two ranges into one cell key.

**Q: Why search 9 cells instead of 1?**

A: Two close points can sit on opposite sides of a cell border and have different geohashes. Reading the user's cell and its 8 neighbours covers everything within one cell-width in every direction.

**Q: How do you pick the geohash length?**

A: Choose the length whose cell is at least as wide as the radius: length 5 (about 4.9 km) for a 2 km search, length 6 (about 1.2 km) for a few hundred metres. Smaller cells mean too many lookups; much bigger cells mean too many candidates to filter.

**Q: Geohash or quadtree?**

A: Geohashes are plain strings, so any key-value store can hold them and they shard easily. Quadtrees adapt to density by splitting crowded squares, but live in each server's memory and must be rebuilt on restart. Many systems use geohashes.

## Related topics

- [Uber Surge Pricing](/?topic=uber-surge&read): hexagonal cells for drivers and riders.
- [Redis Basics](/?topic=redis-basics&read): sets, and the built-in geo commands.
- [Database Sharding](/?topic=database-sharding&read): why to shard by ID, not by location.
- [Distributed Cache](/?topic=distributed-cache&read): caching hot cells and place details.

## Sources

- Gustavo Niemeyer: [Geohash](http://geohash.org/) (the original public geohash service)
- Redis: [GEOSEARCH command](https://redis.io/docs/latest/commands/geosearch/)
- Movable Type Scripts: [Calculate distance between two latitude/longitude points (haversine)](https://www.movable-type.co.uk/scripts/latlong.html)
- PostGIS: [Spatial indexing](https://postgis.net/workshops/postgis-intro/indexing.html)

## Why This Matters

"Design Yelp" or "find nearby drivers" comes up often, and the whole answer turns on one idea: make "near" a key lookup. Geohash cells, the 9-cell search and the true-distance filter are what interviewers look for, along with knowing why a plain index fails and when a quadtree is better.
