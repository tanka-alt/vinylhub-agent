import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const TABLE = "albumid";

// Gemini function-calling declarations — mirror the two n8n Supabase tool
// nodes ("search_albums" and "get_albums_by_genre") including the exact
// parameter names and descriptions the AI used to fill them in via $fromAI().
export const toolDeclarations = [
  {
    name: "search_albums",
    description:
      "Search the catalog by keyword/phrase across artist name and album title.",
    parameters: {
      type: "object",
      properties: {
        search_term: {
          type: "string",
          description:
            'Keyword or phrase to search by artist name or album title, e.g. "Miles Davis" or "Kind of Blue"',
        },
      },
      required: ["search_term"],
    },
  },
  {
    name: "get_albums_by_genre",
    description: "List records for a specific genre.",
    parameters: {
      type: "object",
      properties: {
        genre_slug: {
          type: "string",
          description:
            "Lowercase English genre slug to filter by. Map the spoken genre to the closest of: " +
            "ambient, blues, dnb, electronic, funk, hiphop, indie, jazz, kpop, country, classic, metal, " +
            "pop, punk, reggae, rnb, rock, soul",
        },
      },
      required: ["genre_slug"],
    },
  },
];

// The original n8n node ran two separate ilike filters (artist, album).
// n8n's Supabase "getAll" node combines multiple filter conditions with
// AND, but the tool's own stated purpose ("search across artist name and
// album title") only makes sense as an OR — a single search term is very
// unlikely to appear in both fields at once. This implements it as OR.
// If real-world results don't match what the old n8n assistant returned,
// this is the first place to check.
function escapeIlike(value) {
  return String(value).replace(/[%_]/g, (m) => `\\${m}`);
}

async function search_albums({ search_term }) {
  const term = escapeIlike(search_term ?? "");
  console.log(`[search_albums] called with search_term="${search_term}"`);
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .or(`artist.ilike.%${term}%,album.ilike.%${term}%`)
    .limit(10);

  if (error) {
    console.log(`[search_albums] Supabase error:`, error.message);
    throw new Error(`search_albums failed: ${error.message}`);
  }
  console.log(`[search_albums] Supabase returned ${data?.length ?? 0} row(s)`);
  return data ?? [];
}

async function get_albums_by_genre({ genre_slug }) {
  console.log(`[get_albums_by_genre] called with genre_slug="${genre_slug}"`);
  // .contains() doesn't reliably JSON-encode an array-of-objects value for a
  // jsonb column (supabase-js has sent malformed payloads for this shape in
  // the past, which Postgres then rejects with "invalid input syntax for
  // type json"). Building the jsonb containment filter manually via
  // .filter(column, "cs", <json string>) sidesteps that encoding entirely.
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .filter("zanrid", "cs", JSON.stringify([{ slug: genre_slug }]))
    .limit(10);

  if (error) {
    console.log(`[get_albums_by_genre] Supabase error:`, error.message);
    throw new Error(`get_albums_by_genre failed: ${error.message}`);
  }
  console.log(`[get_albums_by_genre] Supabase returned ${data?.length ?? 0} row(s)`);
  return data ?? [];
}

const implementations = { search_albums, get_albums_by_genre };

export async function runTool(name, args) {
  const fn = implementations[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(args ?? {});
}
