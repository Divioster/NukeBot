/**
 * Weapon Infrastructure Damage Calculations for Politics & War
 * Modeled strictly after Eris weapon damage and rebuild valuation mechanics.
 */

// Precomputed Cumulative Infrastructure Cost Table up to 10,000 infra (~80 KB memory)
// Unit price formula: ((infra - 10)^2.2 / 710) + 300
const MAX_PRECOMPUTED_INFRA = 10000;
const INFRA_COST_TABLE = new Float64Array(MAX_PRECOMPUTED_INFRA + 1);

(function initInfraCostTable() {
    let currentCost = 0;
    let s = 10;
    for (let i = 11; i <= MAX_PRECOMPUTED_INFRA; i++) {
        const pricePerUnit = (Math.pow(s - 10, 2.2) / 710) + 300;
        currentCost += pricePerUnit;
        INFRA_COST_TABLE[i] = currentCost;
        s++;
    }
})();

/**
 * Calculates the expected value, min, and max of min(R, L) where R ~ Uniform(A, B).
 * @param {number} A - Lower bound of the random roll
 * @param {number} B - Upper bound of the random roll
 * @param {number} L - Upper cap limit (min of City Infra Limit and Total City Infra)
 * @returns {{ expected: number, min: number, max: number }}
 */
function calculateTruncatedUniformStats(A, B, L) {
    if (L <= 0) {
        return { expected: 0, min: 0, max: 0 };
    }

    if (L <= A) {
        return { expected: L, min: L, max: L };
    }

    if (L >= B) {
        return {
            expected: (A + B) / 2,
            min: A,
            max: B,
        };
    }

    // A < L < B
    // Truncated uniform expectation:
    // E[min(R, L)] = (2 * B * L - L^2 - A^2) / (2 * (B - A))
    const expected = (2 * B * L - Math.pow(L, 2) - Math.pow(A, 2)) / (2 * (B - A));
    return {
        expected,
        min: A,
        max: L,
    };
}

/**
 * Calculates effective/final population and displayed population density,
 * factoring in disease and crime per Politics & War city mechanics.
 */
function computeDisplayPopDensity({
    infra,
    land,
    popDensity,
    population,
    disease,
    hospital = 0,
    pollution = 0,
} = {}) {
    const totalInfra = Math.max(0, Number(infra) || 0);
    const effectiveLand = Math.max(1, Number(land) || totalInfra || 1);
    const basePopulation = totalInfra * 100;

    if (popDensity !== undefined && popDensity !== null && !isNaN(popDensity)) {
        const d = Math.max(0, Number(popDensity));
        return {
            basePopulation,
            finalPopulation: Math.round(d * effectiveLand),
            displayPopDensity: d,
            diseaseRate: 0,
        };
    }

    if (population !== undefined && population !== null && !isNaN(population)) {
        const p = Math.max(0, Number(population));
        return {
            basePopulation,
            finalPopulation: p,
            displayPopDensity: p / effectiveLand,
            diseaseRate: 0,
        };
    }

    // Standard P&W formula for population & disease
    const initDensity = basePopulation / effectiveLand;

    let diseaseRate;
    if (disease !== undefined && disease !== null && !isNaN(disease)) {
        diseaseRate = Math.max(0, Number(disease));
    } else {
        const pollutionModifier = Number(pollution || 0) * 0.05;
        const hospitalModifier = Number(hospital || 0) * 2.5;
        diseaseRate = ((((Math.pow(initDensity, 2)) * 0.01) - 25) / 100) + (basePopulation / 100000) + pollutionModifier - hospitalModifier;
        if (diseaseRate < 0) diseaseRate = 0;
    }

    // Crime rate with baseline 100% commerce
    const crimeRate = Math.max(0, Math.min(100, (Math.pow(103 - 100, 2) + (totalInfra * 100)) / 111111));

    const diseaseLoss = (diseaseRate * 100 * totalInfra) / 100;
    const crimeLoss = Math.max((crimeRate / 10) * (100 * totalInfra) - 25, 0);
    let finalPopulation = Math.round(basePopulation - diseaseLoss - crimeLoss);
    if (finalPopulation < 0) finalPopulation = 0;

    const displayPopDensity = finalPopulation / effectiveLand;

    return {
        basePopulation,
        finalPopulation,
        displayPopDensity,
        diseaseRate: Math.round(diseaseRate * 100) / 100,
    };
}

/**
 * Calculate Nuclear Weapon infrastructure damage.
 * @param {Object} params
 * @param {number} params.infra - City infrastructure level
 * @param {number} [params.land] - City land area (sq mi, defaults to infra level if omitted)
 * @param {number} [params.popDensity] - Population density override
 * @param {number} [params.population] - Actual population override
 * @param {number} [params.disease] - Disease rate % override
 * @param {boolean} [params.guidingSatellite=false] - Whether Guiding Satellite (+20% damage) is active
 * @returns {Object} Damage calculation details
 */
function calculateNukeDamage({ infra, land, popDensity, population, disease, guidingSatellite = false } = {}) {
    const totalCityInfra = Math.max(0, Number(infra) || 0);

    const isDefaultLand = !(land !== undefined && land !== null && Number(land) > 0);
    const effectiveLand = isDefaultLand ? Math.max(1, totalCityInfra) : Number(land);

    const popData = computeDisplayPopDensity({
        infra: totalCityInfra,
        land: effectiveLand,
        popDensity,
        population,
        disease,
    });

    const A = 1700;
    const densityCap = popData.displayPopDensity * 13.5;
    const B = Math.max(2000, densityCap);

    const cityInfraLimit = Math.max(0, (totalCityInfra * 0.8) + 150);
    const limit = Math.min(cityInfraLimit, totalCityInfra);

    const stats = calculateTruncatedUniformStats(A, B, limit);
    const satMultiplier = guidingSatellite ? 1.2 : 1.0;

    const minDamage = Math.min(totalCityInfra, Math.round(stats.min * satMultiplier * 100) / 100);
    const maxDamage = Math.min(totalCityInfra, Math.round(stats.max * satMultiplier * 100) / 100);
    const expectedDamage = Math.min(totalCityInfra, Math.round(stats.expected * satMultiplier * 100) / 100);
    const remainingInfra = Math.max(0, Math.round((totalCityInfra - expectedDamage) * 100) / 100);

    return {
        weapon: 'nuke',
        totalCityInfra,
        land: effectiveLand,
        isDefaultLand,
        basePopulation: popData.basePopulation,
        finalPopulation: popData.finalPopulation,
        popDensity: Math.round(popData.displayPopDensity * 100) / 100,
        diseaseRate: popData.diseaseRate,
        guidingSatellite: Boolean(guidingSatellite),
        satelliteMultiplier: satMultiplier,
        baseMin: A,
        baseMax: B,
        cityInfraLimit,
        effectiveLimit: limit,
        minDamage,
        maxDamage,
        expectedDamage,
        remainingInfra,
    };
}

/**
 * Calculates total cumulative infrastructure replacement cost from level 10 to target infra.
 * Uses O(1) precomputed lookup table up to 10,000 infra.
 * @param {number} infra - Infrastructure level
 * @returns {number} Total replacement cost in dollars
 */
function calculateInfraCost(infra) {
    const val = Math.max(0, Number(infra) || 0);
    if (val <= 10) return 0;

    const floor = Math.floor(val);
    if (floor <= MAX_PRECOMPUTED_INFRA) {
        const baseCost = INFRA_COST_TABLE[floor];
        const frac = val - floor;
        if (frac > 0) {
            const unitPrice = (Math.pow(val - 10, 2.2) / 710) + 300;
            return Math.round((baseCost + unitPrice * frac) * 100) / 100;
        }
        return Math.round(baseCost * 100) / 100;
    }

    // Dynamic chunk calculation fallback if beyond 10,000 infra
    let s = 10;
    let diff = val - 10;
    let total = 0;
    while (diff > 0) {
        const chunk = Math.min(100, diff);
        const unitPrice = (Math.pow(s - 10, 2.2) / 710) + 300;
        total += unitPrice * chunk;
        s += chunk;
        diff -= chunk;
    }
    return Math.round(total * 100) / 100;
}

/**
 * Calculates the dollar replacement cost destroyed when infrastructure is damaged.
 * Convex destruction curve: higher infra levels cost significantly more per point.
 * @param {number} currentInfra - Starting city infrastructure
 * @param {number} damageDestroyed - Infrastructure points destroyed
 * @returns {number} Dollar value destroyed
 */
function calculateDamageValue(currentInfra, damageDestroyed) {
    const current = Math.max(0, Number(currentInfra) || 0);
    const dmg = Math.min(current, Math.max(0, Number(damageDestroyed) || 0));
    const remaining = Math.max(0, current - dmg);

    const costCurrent = calculateInfraCost(current);
    const costRemaining = calculateInfraCost(remaining);
    return Math.max(0, Math.round((costCurrent - costRemaining) * 100) / 100);
}

/**
 * Formats a number with comma separators
 */
function addCommas(number) {
    if (number === null || number === undefined || isNaN(number)) return '0';
    return new Intl.NumberFormat('en-US').format(Math.round(number));
}

/**
 * Formats currency values in a clean, human-readable format ($X.XXB, $X.XXM, etc.)
 */
function formatCash(amount) {
    const num = Number(amount) || 0;
    if (num >= 1e9) {
        return `$${(num / 1e9).toFixed(2)}B`;
    }
    if (num >= 1e6) {
        return `$${(num / 1e6).toFixed(2)}M`;
    }
    if (num >= 1e3) {
        return `$${(num / 1e3).toFixed(1)}k`;
    }
    return `$${addCommas(num)}`;
}

module.exports = {
    calculateTruncatedUniformStats,
    computeDisplayPopDensity,
    calculateNukeDamage,
    calculateInfraCost,
    calculateDamageValue,
    addCommas,
    formatCash,
    MAX_PRECOMPUTED_INFRA,
    INFRA_COST_TABLE,
};
