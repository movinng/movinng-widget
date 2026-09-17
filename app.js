require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FACEIT_API_KEY = process.env.FACEIT_API_KEY;

if (!FACEIT_API_KEY) {
    console.error("ERROR: Missing FACEIT_API_KEY in your .env file.");
    process.exit(1);
}

const cache = new Map();
const CACHE_TTL = 4 * 60 * 1000; // 5 minutes

app.use(express.static(path.join(__dirname, 'public')));

async function fetchFaceit(endpoint) {
    const res = await fetch(`https://open.faceit.com/data/v4${endpoint}`, {
        headers: { 'Authorization': `Bearer ${FACEIT_API_KEY}` }
    });
    
    const data = await res.json();
    
    if (!res.ok) {
        if (res.status === 401) throw new Error("Invalid FACEIT API Key.");
        if (res.status === 404) throw new Error("Player not found.");
        if (res.status === 429) throw new Error("Rate limited. Try again in a minute.");
        
        const errMsg = data.errors ? Object.values(data.errors).join(', ') : `API Error: ${res.status}`;
        throw new Error(errMsg);
    }
    return data;
}

// Fetches stats for a batch of matches to avoid rate limits
async function fetchMatchStatsBatch(playerId, matches) {
    let totalKills = 0;
    let totalDeaths = 0;
    let totalADR = 0;
    let validADRMatches = 0;
    let wins = 0;
    const recentGames = [];

    const fetchMatchStats = async (match) => {
        let kills = 0, deaths = 0, adr = 0, won = false;
        try {
            const detailedStats = await fetchFaceit(`/matches/${match.match_id}/stats`);
            const round = detailedStats.rounds && detailedStats.rounds[0];
            if (round && round.teams) {
                for (const team of round.teams) {
                    const player = team.players.find(p => p.player_id === playerId);
                    if (player && player.player_stats) {
                        kills = parseInt(player.player_stats.Kills || 0);
                        deaths = parseInt(player.player_stats.Deaths || 0);
                        const playerADR = parseFloat(player.player_stats.ADR || 0);
                        
                        if (playerADR > 0) {
                            adr = playerADR;
                        }
                        won = player.player_stats.Result === '1';
                        break;
                    }
                }
            }
        } catch (err) {
            console.warn(`Skipped match ${match.match_id} due to error/rate limit`);
        }
        return { kills, deaths, adr, won };
    };

    let resolvedStats = [];
    const batchSize = 5;
    for (let i = 0; i < matches.length; i += batchSize) {
        const batch = matches.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(fetchMatchStats));
        resolvedStats = resolvedStats.concat(batchResults);
    }

    resolvedStats.forEach(stat => {
        totalKills += stat.kills;
        totalDeaths += stat.deaths;
        if (stat.adr > 0) {
            totalADR += stat.adr;
            validADRMatches++;
        }
        if (stat.won) wins++;
    });

    // Get the 5 most recent games for the UI
    const last5 = resolvedStats.slice(0, 5).map(stat => ({
        result: stat.won ? 'W' : 'L',
        kills: stat.kills,
        deaths: stat.deaths,
        adr: stat.adr > 0 ? stat.adr.toFixed(1) : '0.0'
    }));

    // Calculate average kills per game
    const avgKills = matches.length > 0 ? (totalKills / matches.length).toFixed(1) : "0.0";

    // Make sure avgKills is included in the return object!
    return {
        kd: totalDeaths === 0 ? totalKills : (totalKills / totalDeaths).toFixed(2),
        adr: validADRMatches > 0 ? (totalADR / validADRMatches).toFixed(1) : "0.0",
        avgKills: avgKills,
        recentGames: last5
    };
}

app.get('/api/stats/:nickname', async (req, res) => {
    const { nickname } = req.params;
    const cacheKey = nickname.toLowerCase();

    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return res.json(cached.data);
        }
    }

    try {
        // 1. Get Player ID, Level, Elo, and Country
        const playerData = await fetchFaceit(`/players?nickname=${encodeURIComponent(nickname)}`);
        const playerId = playerData.player_id;
        const cleanNickname = playerData.nickname || nickname;
        const country = playerData.country || "";
        
        const games = playerData.games || {};
        const gameData = games.cs2 || games.csgo || {};
        
        const level = gameData.skill_level || 0;
        const elo = gameData.faceit_elo || 0;
        const isChallenger = level >= 11;

        if (!playerId) throw new Error("Player ID missing.");

        // 2. Get Past 20 Matches History
        const history = await fetchFaceit(`/players/${playerId}/history?game=cs2&limit=20`);
        const matches = history.items || [];

        let stats = { kd: "0.00", adr: "0.0", avgKills: "0.0", recentGames: [] };
        
        if (matches.length > 0) {
            // 3. Calculate exact stats from real match data
            stats = await fetchMatchStatsBatch(playerId, matches);
        }

        const result = {
            nickname: cleanNickname,
            country,
            level,
            elo,
            kd: stats.kd,
            adr: stats.adr,
            avgKills: stats.avgKills,
            isChallenger: isChallenger,
            recentGames: stats.recentGames
        };

        cache.set(cacheKey, { timestamp: Date.now(), data: result });
        res.json(result);

    } catch (error) {
        console.error(`Error processing ${nickname}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});