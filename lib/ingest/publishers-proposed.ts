import type { PublisherDomainRow } from "./publishers";

/**
 * THE PROPOSED TIERS (allowlist review of 2026-09-29), behind the Phase 31
 * switch. Every outlet that resolved to the unlisted floor (tier 5) three or
 * more times in the thirty days to 09-29, placed under the published rubric
 * (README, "Publisher tiers: the rubric"). Read-only against production: a
 * row here changes nothing until SIGNAL_QUALITY_ENABLED is on, and a
 * publisher_domains row for the same domain always wins, so the operator can
 * override any line by inserting one.
 *
 * DO_NOT_LIST names the domains that stay at the floor on purpose:
 * aggregators, content farms, platforms, the subjects' own channels. They are
 * not blocked (their items still arrive at tier 5 and the namesake guard still
 * judges them) and never promoted. Funeral and obituary sites are refused
 * earlier, by the obituary guard, and are not repeated here.
 */

export interface ProposedTier {
  tier: 1 | 2 | 3 | 4;
  reason: string;
}

export const PROPOSED_TIERS: Record<string, ProposedTier> = {
  // Tier 1: wire services and major national or international papers of record; the trade papers of record beside Variety and THR.
  "latimes.com": { tier: 1, reason: "Los Angeles Times: major national paper of record" },
  "ft.com": { tier: 1, reason: "Financial Times: international paper of record for business" },
  "deadline.com": { tier: 1, reason: "Deadline: entertainment trade of record, beside Variety and The Hollywood Reporter" },

  // Tier 2: major magazines, national broadcasters, established trade and sports press.
  "cnn.com": { tier: 2, reason: "CNN: national broadcaster" },
  "nbcnews.com": { tier: 2, reason: "NBC News: national broadcaster" },
  "abcnews.com": { tier: 2, reason: "ABC News: national broadcaster" },
  "cbsnews.com": { tier: 2, reason: "CBS News: national broadcaster" },
  "foxnews.com": { tier: 2, reason: "Fox News: national broadcaster (its opinion output is not a reason to leave the news desk unlisted)" },
  "foxbusiness.com": { tier: 2, reason: "Fox Business: national broadcaster's business desk" },
  "npr.org": { tier: 2, reason: "NPR: national public broadcaster" },
  "skysports.com": { tier: 2, reason: "Sky Sports: national broadcaster's sports desk, beside NBC Sports and CBS Sports" },
  "politico.com": { tier: 2, reason: "Politico: established national political press" },
  "thehill.com": { tier: 2, reason: "The Hill: established national political press" },
  "axios.com": { tier: 2, reason: "Axios: established national newsroom" },
  "fortune.com": { tier: 2, reason: "Fortune: major business magazine, beside Forbes" },
  "newsweek.com": { tier: 2, reason: "Newsweek: major national magazine; its true report on the MrBeast trainer's death was zeroed at the floor" },
  "time.com": { tier: 2, reason: "Time: major national magazine" },
  "barrons.com": { tier: 2, reason: "Barron's: established financial magazine (Dow Jones)" },
  "marketwatch.com": { tier: 2, reason: "MarketWatch: established financial press (Dow Jones)" },
  "newrepublic.com": { tier: 2, reason: "The New Republic: major national magazine" },
  "vanityfair.com": { tier: 2, reason: "Vanity Fair: major national magazine (Condé Nast)" },
  "independent.co.uk": { tier: 2, reason: "The Independent: UK national paper" },
  "scmp.com": { tier: 2, reason: "South China Morning Post: major international paper (Hong Kong)" },

  // Tier 3: established regional papers and reputable specialist outlets.
  "nypost.com": { tier: 3, reason: "New York Post: metro tabloid daily with a reporting desk" },
  "miamiherald.com": { tier: 3, reason: "Miami Herald: established regional paper" },
  "sacbee.com": { tier: 3, reason: "Sacramento Bee: established regional paper" },
  "chron.com": { tier: 3, reason: "Houston Chronicle: established regional paper" },
  "sfchronicle.com": { tier: 3, reason: "San Francisco Chronicle: established regional paper" },
  "palmbeachpost.com": { tier: 3, reason: "Palm Beach Post: established regional paper" },
  "bizjournals.com": { tier: 3, reason: "American City Business Journals: established regional business press" },
  "thestreet.com": { tier: 3, reason: "TheStreet: reputable specialist financial outlet" },
  "investors.com": { tier: 3, reason: "Investor's Business Daily: reputable specialist financial outlet" },
  "inc.com": { tier: 3, reason: "Inc.: reputable specialist business outlet" },
  "mashable.com": { tier: 3, reason: "Mashable: established technology and culture desk" },
  "gizmodo.com": { tier: 3, reason: "Gizmodo: established technology desk" },
  "tomshardware.com": { tier: 3, reason: "Tom's Hardware: reputable specialist technology outlet" },
  "thenextweb.com": { tier: 3, reason: "The Next Web: established technology desk" },
  "thedailybeast.com": { tier: 3, reason: "The Daily Beast: established national newsroom, tabloid register" },
  "tmz.com": { tier: 3, reason: "TMZ: celebrity press that breaks and confirms; tabloid register" },
  "jpost.com": { tier: 3, reason: "The Jerusalem Post: established national paper (Israel), English" },
  "calcalistech.com": { tier: 3, reason: "Calcalist (CTech): Israeli business daily's technology desk" },
  "e.vnexpress.net": { tier: 3, reason: "VnExpress International: major Vietnamese daily, English" },
  "timesofindia.indiatimes.com": { tier: 3, reason: "The Times of India: major national daily, but its subject coverage here is an entertainment desk's churn (70 items in 30 days); a regional-paper weight, not a paper of record's" },
  "ndtv.com": { tier: 3, reason: "NDTV: Indian national broadcaster; the same churn register as above" },
  "sports.ndtv.com": { tier: 3, reason: "NDTV Sports: as ndtv.com" },
  "m.economictimes.com": { tier: 3, reason: "The Economic Times: major Indian business daily (mobile edition)" },
  "marca.com": { tier: 3, reason: "Marca: Spain's national sports daily" },
  "kmbc.com": { tier: 3, reason: "KMBC Kansas City: local TV news, beside FOX4 and KCTV5" },
  "kshb.com": { tier: 3, reason: "KSHB Kansas City: local TV news" },
  "kltv.com": { tier: 3, reason: "KLTV Tyler, Texas: local TV news (Mahomes' home town)" },
  "arrowheadaddict.com": { tier: 3, reason: "Arrowhead Addict (FanSided): Chiefs team blog, beside Arrowhead Pride; partisan by design" },

  // Tier 4: blogs and smaller sites with a named editorial identity.
  "fool.com": { tier: 4, reason: "The Motley Fool: named editorial identity, but volume-driven stock commentary with disclosed positions (48 items in 30 days)" },
  "benzinga.com": { tier: 4, reason: "Benzinga: named newsroom mixed with a press-release wire and 'X says' churn; 41 items and the largest unlisted impact (4.32), which is the reason it is not higher" },
  "247wallst.com": { tier: 4, reason: "24/7 Wall St.: named editorial staff; listicle register" },
  "heavy.com": { tier: 4, reason: "Heavy: named editorial staff; aggregation register" },
  "hitc.com": { tier: 4, reason: "HITC: sports and entertainment site with a named desk" },
  "atozsports.com": { tier: 4, reason: "A to Z Sports: regional sports site with a named desk" },
  "fantasylife.com": { tier: 4, reason: "Fantasy Life: fantasy football desk" },
  "rotoballer.com": { tier: 4, reason: "RotoBaller: fantasy football desk" },
  "profootballnetwork.com": { tier: 4, reason: "Pro Football Network: NFL site with a named desk" },
  "nfltraderumors.co": { tier: 4, reason: "NFL Trade Rumors: notes digest with a named editor" },
  "thebiglead.com": { tier: 4, reason: "The Big Lead: sports media blog with a named desk" },
  "athlonsports.com": { tier: 4, reason: "Athlon Sports: sports site with a named desk" },
  "bloodyelbow.com": { tier: 4, reason: "Bloody Elbow: combat-sports blog with a named desk" },
  "mensjournal.com": { tier: 4, reason: "Men's Journal: a magazine name now running a high-volume web desk" },
  "seekingalpha.com": { tier: 4, reason: "Seeking Alpha: its news desk is real; the contributor articles are not vetted, so no higher" },
  "barchart.com": { tier: 4, reason: "Barchart: market data site with a named editorial desk" },
  "billionaires.africa": { tier: 4, reason: "Billionaires.Africa: wealth-tracking site with a named desk; wealth-ranking register" },
  "beincrypto.com": { tier: 4, reason: "BeInCrypto: crypto news site with a named desk" },
  "eu.36kr.com": { tier: 4, reason: "36Kr (European edition): Chinese technology media, translated" },
  "gtaboom.com": { tier: 4, reason: "GTA Boom: games site with a named desk" },
  "win.gg": { tier: 4, reason: "WIN.gg: esports and streaming site with a named desk, below Dexerto" },
  "teslarati.com": { tier: 4, reason: "Teslarati: EV enthusiast site with a named desk; close to its subject" },
  "wccftech.com": { tier: 4, reason: "Wccftech: hardware site with a named desk" },
  "futurism.com": { tier: 4, reason: "Futurism: technology site with a named desk; a provocative register" },
  "garymarcus.substack.com": { tier: 4, reason: "Gary Marcus's newsletter: a named author" },
  "dailykos.com": { tier: 4, reason: "Daily Kos: partisan blog with a named desk" },
  "pajiba.com": { tier: 4, reason: "Pajiba: entertainment blog with a named desk" },
  "cassiuslife.com": { tier: 4, reason: "Cassius: culture site with a named desk" },
  "inmusicblog.com": { tier: 4, reason: "In Music Blog: music blog with a named desk" },
  "dancehallmag.com": { tier: 4, reason: "DancehallMag: music site with a named desk" },
  "the-sun.com": { tier: 4, reason: "The Sun (US edition): tabloid; a named desk, low reliability" },
};

/**
 * Stay at the floor, on purpose: not publishers of their own reporting, or
 * not verifiable as one. Listed so the next review does not re-ask.
 */
export const DO_NOT_LIST: Record<string, string> = {
  "youtu.be": "the subjects' own videos, not coverage of them",
  "facebook.com": "a platform; the post's author is the source, and unknown",
  "stocktwits.com": "a social platform for stock chatter",
  "tradingview.com": "a platform syndicating others' news",
  "finance.biggo.com": "an aggregator of syndicated finance stories",
  "aol.com": "an aggregator of syndicated stories (Yahoo's tier-3 row is the precedent; kept at the floor pending the same review of yahoo.com)",
  "imdb.com": "a reference database, not a newsroom",
  "britannica.com": "a reference work",
  "realtor.com": "a listings site with a content desk",
  "urbanstreet.com.pe": "a content farm",
  "thecooldown.com": "a content farm",
  "moneywise.com": "a content farm",
  "luxurylaunches.com": "a content farm",
  "eciks.org": "unverifiable: an organisation site republishing list coverage",
  "chiefs.com": "the subject's own team, promotional by nature (the nfl.com precedent is the league, held at tier 2; a team is closer still)",
  "wgrv.com": "a real local radio station, but the one item it sent was a bare name that became a false death; unverifiable relevance, stays at the floor",
};

/** The proposal as allowlist rows, for the policy. */
export function proposedPublisherRows(): PublisherDomainRow[] {
  return Object.entries(PROPOSED_TIERS).map(([domain, proposal]) => ({ domain, status: "allowed", tier: proposal.tier }));
}

/**
 * The database's rows with the proposal laid beneath them: a domain the
 * operator has listed keeps its row, everything else in the proposal is
 * added. Only under the switch; off, the rows are returned as they are.
 */
export function withProposedTiers(rows: PublisherDomainRow[], enabled: boolean): PublisherDomainRow[] {
  if (!enabled) return rows;
  const listed = new Set(rows.map((row) => row.domain.toLowerCase()));
  return [...rows, ...proposedPublisherRows().filter((row) => !listed.has(row.domain))];
}
