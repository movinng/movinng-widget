const express = require('express');
const path = require('path');

const app = express();

const FACEIT_API_KEY = process.env.FACEIT_API_KEY;

if (!FACEIT_API_KEY) {
    console.warn('WARNING: Missing FACEIT_API_KEY');
}

const cache = new Map();
const CACHE_TTL = 4 * 60 * 1000;

app.use(express.static(path.join(__dirname, 'public')));

async function fetchFaceit(endpoint) {
    const res = await fetch(
        `https://open.faceit.com/data/v4${endpoint}`,
        {
            headers: {
                Authorization: `Bearer ${FACEIT_API_KEY}`,
                Accept: 'application/json'
            }
        }
    );

    const text = await res.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        console.error('Non-JSON response from FACEIT:', {
            status: res.status,
            contentType: res.headers.get('content-type'),
            body: text.substring(0, 500)
        });

        throw new Error(
            `FACEIT returned non-JSON data (${res.status})`
        );
    }

    if (!res.ok) {
        if (res.status === 401) {
            throw new Error('Invalid FACEIT API Key.');
        }

        if (res.status === 404) {
            throw new Error('Player not found.');
        }

        if (res.status === 429) {
            throw new Error('Rate limited. Try again in a minute.');
        }

        const errMsg = data.errors
            ? Object.values(data.errors).join(', ')
            : `API Error: ${res.status}`;

        throw new Error(errMsg);
    }

    return data;
}

async function fetchMatchStatsBatch(playerId, matches) {
    let totalKills = 0;
    let totalDeaths = 0;
    let totalADR = 0;
    let validADRMatches = 0;
    let wins = 0;

    const fetchMatchStats = async (match) => {
        let kills = 0;
        let deaths = 0;
        let adr = 0;
        let won = false;

        try {
            const detailedStats = await fetchFaceit(
                `/matches/${match.match_id}/stats`
            );

            const round = detailedStats.rounds?.[0];

            if (round?.teams) {
                for (const team of round.teams) {
                    const player = team.players.find(
                        p => p.player_id === playerId
                    );

                    if (player?.player_stats) {
                        kills = parseInt(
                            player.player_stats.Kills || 0
                        );

                        deaths = parseInt(
                            player.player_stats.Deaths || 0
                        );

                        const playerADR = parseFloat(
                            player.player_stats.ADR || 0
                        );

                        if (playerADR > 0) {
                            adr = playerADR;
                        }

                        won = player.player_stats.Result === '1';

                        break;
                    }
                }
            }
        } catch (err) {
            console.warn(
                `Skipped match ${match.match_id}:`,
                err.message
            );
        }

        return {
            kills,
            deaths,
            adr,
            won
        };
    };

    const resolvedStats = [];
    const batchSize = 5;

    for (let i = 0; i < matches.length; i += batchSize) {
        const batch = matches.slice(i, i + batchSize);

        const results = await Promise.all(
            batch.map(fetchMatchStats)
        );

        resolvedStats.push(...results);
    }

    resolvedStats.forEach(stat => {
        totalKills += stat.kills;
        totalDeaths += stat.deaths;

        if (stat.adr > 0) {
            totalADR += stat.adr;
            validADRMatches++;
        }

        if (stat.won) {
            wins++;
        }
    });

    const last5 = resolvedStats.slice(0, 5).map(stat => ({
        result: stat.won ? 'W' : 'L',
        kills: stat.kills,
        deaths: stat.deaths,
        adr: stat.adr > 0
            ? stat.adr.toFixed(1)
            : '0.0'
    }));

    return {
        kd: totalDeaths === 0
            ? totalKills.toFixed(2)
            : (totalKills / totalDeaths).toFixed(2),

        adr: validADRMatches > 0
            ? (totalADR / validADRMatches).toFixed(1)
            : '0.0',

        avgKills: matches.length > 0
            ? (totalKills / matches.length).toFixed(1)
            : '0.0',

        recentGames: last5
    };
}

app.get('/api/stats/:nickname', async (req, res) => {
    const { nickname } = req.params;

    console.log(`API request for player: ${nickname}`);

    const cacheKey = nickname.toLowerCase();

    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);

        if (Date.now() - cached.timestamp < CACHE_TTL) {
            console.log(`Cache hit: ${nickname}`);
            return res.json(cached.data);
        }

        cache.delete(cacheKey);
    }

    try {
        const playerData = await fetchFaceit(
            `/players?nickname=${encodeURIComponent(nickname)}`
        );

        const playerId = playerData.player_id;

        if (!playerId) {
            throw new Error('Player ID missing.');
        }

        const cleanNickname = playerData.nickname || nickname;
        const country = playerData.country || '';

        const games = playerData.games || {};
        const gameData = games.cs2 || games.csgo || {};

        const level = gameData.skill_level || 0;
        const elo = gameData.faceit_elo || 0;

        const history = await fetchFaceit(
            `/players/${playerId}/history?game=cs2&limit=20`
        );

        const matches = history.items || [];

        let stats = {
            kd: '0.00',
            adr: '0.0',
            avgKills: '0.0',
            recentGames: []
        };

        if (matches.length > 0) {
            stats = await fetchMatchStatsBatch(
                playerId,
                matches
            );
        }

        const result = {
            nickname: cleanNickname,
            country,
            level,
            elo,
            kd: stats.kd,
            adr: stats.adr,
            avgKills: stats.avgKills,
            isChallenger: level >= 11,
            recentGames: stats.recentGames
        };

        cache.set(cacheKey, {
            timestamp: Date.now(),
            data: result
        });

        return res.json(result);

    } catch (error) {
        console.error(
            `Error processing ${nickname}:`,
            error
        );

        return res.status(500).json({
            error: error.message
        });
    }
});

module.exports = app;