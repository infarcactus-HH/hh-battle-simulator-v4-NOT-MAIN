import { createBattleTable } from '../dom/battle-table';
import { createBoosterChanceTableWithAME, createSkillChanceTableWithAME } from '../dom/booster-simulation';
import { ChanceView } from '../dom/chance';
import { MojoView } from '../dom/mojo';
import { Popup } from '../dom/popup';
import { getConfig } from '../interop/hh-plus-plus-config';
import { simulateFromBattlers } from '../simulator/battle';
import {
    simulateChanceForBoosterCombinationWithAME,
    simulateChanceForSkillCombinationWithAME,
} from '../simulator/booster';
import { calcBattlerFromFighters } from '../simulator/fighter';
import { calcCounterBonus } from '../simulator/team';
import { loadMythicBoosterBonus, saveMythicBoosterBonus } from '../store/booster';
import { saveOpponentTeamData } from '../store/team';
import { afterGameInited, beforeGameInited } from '../utils/async';
import { checkPage } from '../utils/page';
import { GameWindow, assertGameWindow } from './base/common';
import { HeroData, Opponent, SeasonArenaGlobal } from './types/season-arena';

type SeasonArenaWindow = GameWindow & SeasonArenaGlobal;

function assertSeasonArenaWindow(window: Window): asserts window is SeasonArenaWindow {
    assertGameWindow(window);
    const { hero_data, caracs_per_opponent, opponents } = window;
    if (hero_data == null) throw new Error('hero_data is not found.');
    if (caracs_per_opponent == null) throw new Error('caracs_per_opponent is not found.');
    if (opponents == null) throw new Error('opponents is not found.');
}

export async function SeasonArenaPage(window: Window) {
    if (!checkPage('/season-arena.html')) return;
    await beforeGameInited();

    assertSeasonArenaWindow(window);
    let { hero_data, caracs_per_opponent, opponents } = window;

    updateMythicBooster();
    saveOpponentTeam(window);
    const config = getConfig();
    if (config.doSimulateSeason) {
        if (config.addBoosterSimulator) addBoosterSimulator(window);
        if (config.addSkillSimulator) addSkillSimulator(window);

        $(document).ajaxComplete((_event, jqXHR, ajaxOptions) => {
            const { url, data } = ajaxOptions;
            if (!url?.startsWith('/ajax.php')) return;
            if (typeof data === 'string' && data.includes('action=season_arena_reload')) {
                const { battle_data } = jqXHR.responseJSON as {
                    battle_data: {
                        hero_fighter: HeroData;
                        opponents: Opponent[];
                        caracs_per_opponent: SeasonArenaWindow['caracs_per_opponent'];
                    };
                };
                ({ hero_fighter: hero_data, opponents, caracs_per_opponent } = battle_data);
            }
        });

        const opponentContainer = document.querySelector('.opponents_arena');
        if (opponentContainer != null) {
            if (document.querySelectorAll('.season_arena_opponent_container[data-opponent]').length > 0) {
                addSimulation();
                new MutationObserver(e => {
                    addSimulation();
                }).observe(opponentContainer, {
                    childList: false,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['data-opponent'],
                });
            }
        }
    }

    async function addSimulation() {
        opponents.forEach(async (opponent_fighter, i) => {
            const opponentFighter = opponent_fighter.player;
            const opponentId = opponentFighter.id_fighter;
            const playerFighter = { ...hero_data, ...caracs_per_opponent[opponentId] };
            const player = calcBattlerFromFighters(playerFighter, opponentFighter);
            const opponent = calcBattlerFromFighters(opponentFighter, playerFighter);
            const resultPromise = simulateFromBattlers('Chance', player, opponent);
            const mojo = +opponent_fighter.rewards.rewards.find(e => e.type === 'victory_points')!.value;
            const currentMojo = hero_data.current_season_mojo;

            await afterGameInited();

            const chanceView = new ChanceView();
            chanceView.updateAsync(resultPromise);
            chanceView.setTooltip(createBattleTable(player, opponent));

            const mojoView = new MojoView(mojo, currentMojo);
            mojoView.updateAsync(resultPromise);

            $(`.opponent-${i}[data-opponent="${opponentId}"] .icon-area`)
                .before(chanceView.getElement().addClass('sim-left'))
                .before(mojoView.getElement().addClass('sim-right'));
        });
    }

    function updateMythicBooster() {
        const opponent = opponents[0].player;
        const playerCaracs = caracs_per_opponent[opponent.id_fighter];
        const counterBonus = calcCounterBonus(hero_data.team, opponent.team);
        const percentage = Math.round((100 * playerCaracs.damage) / hero_data.team.caracs.damage / counterBonus);

        const mythicBoosterData = loadMythicBoosterBonus();
        mythicBoosterData.seasons = percentage / 100;
        saveMythicBoosterBonus(mythicBoosterData);
    }
}

async function saveOpponentTeam(window: SeasonArenaWindow) {
    const {
        opponents,
        localStorageSetItem,
        hero_data: { current_season_mojo },
    } = window;

    const update = () => {
        localStorageSetItem('battle_type', 'seasons');
        const opponentId = $('.selected_opponent').attr('data-opponent');
        if (opponentId == null) return;
        const opponent = opponents.find(e => +e.player.id_fighter === +opponentId);
        if (opponent == null) return;
        const opponentTeam = opponent.player.team;
        const mojo = opponent.rewards.rewards.find(e => e.type === 'victory_points')?.value;
        saveOpponentTeamData({
            battleType: 'seasons',
            opponentId,
            team: opponentTeam,
            mojo: +(mojo ?? 0),
            currentMojo: current_season_mojo,
        });
    };

    update();

    await afterGameInited();

    const button = document.getElementById('change_team');
    if (button != null) {
        button.addEventListener('click', update, true);
        button.addEventListener('auxclick', update, true);
    }
}

function getOpponent(window: SeasonArenaWindow) {
    const { opponents } = window;
    const opponentId = $('.selected_opponent').attr('data-opponent');
    if (opponentId == null) return;
    const opponent = opponents.find(e => +e.player.id_fighter === +opponentId);
    if (opponent == null) return;
    return opponent;
}

async function addBoosterSimulator(window: SeasonArenaWindow) {
    const { hero_data } = window;
    const playerTeam = hero_data.team;

    await afterGameInited();

    const iconButton = $('<div class="sim-result"><div class="sim-icon-button sim-icon-ame"></div></div>')
        .addClass('sim-right')
        .attr('tooltip', 'Booster simulator');
    const popupMap = {} as Record<number, Popup>;
    iconButton.on('click', () => {
        const opponent = getOpponent(window);
        if (opponent == null) return;
        let popup = popupMap[+opponent.player.id_fighter];
        if (popup == null) {
            popup = new Popup(`Booster simulator (${opponent.player.nickname})`);
            popup.setContent('Now loading...');
            popupMap[+opponent.player.id_fighter] = popup;
            queueMicrotask(async () => {
                try {
                    const results = await simulateChanceForBoosterCombinationWithAME(playerTeam, opponent.player.team);
                    popup.setContent(createBoosterChanceTableWithAME(results));
                } catch (e) {
                    const message = e instanceof Error ? e.message : e;
                    popup.setContent(`Error: ${message}<br>1. Go to the market page<br>2. Try again`);
                }
            });
        }
        Object.values(popupMap)
            .filter(e => e != popup)
            .forEach(e => e.hide());
        popup.toggle();
    });
    $('.battle_hero .icon-area').before(iconButton);
}

async function addSkillSimulator(window: SeasonArenaWindow) {
    const { hero_data } = window;
    const playerTeam = hero_data.team;

    await afterGameInited();

    const iconButton = $('<div class="sim-result"><div class="sim-icon-button sim-icon-girl-skills"></div></div>')
        .addClass('sim-left')
        .attr('tooltip', 'Skill simulator');
    const popupMap = {} as Record<number, Popup>;
    iconButton.on('click', () => {
        const opponent = getOpponent(window);
        if (opponent == null) return;
        let popup = popupMap[+opponent.player.id_fighter];
        if (popup == null) {
            popup = new Popup(`Booster simulator (${opponent.player.nickname})`);
            popup.setContent('Now loading...');
            popupMap[+opponent.player.id_fighter] = popup;
            queueMicrotask(async () => {
                try {
                    const results = await simulateChanceForSkillCombinationWithAME(playerTeam, opponent.player.team);
                    popup.setContent(createSkillChanceTableWithAME(results));
                } catch (e) {
                    const message = e instanceof Error ? e.message : e;
                    popup.setContent(`Error: ${message}<br>1. Go to the market page<br>2. Try again`);
                }
            });
        }
        Object.values(popupMap)
            .filter(e => e != popup)
            .forEach(e => e.hide());
        popup.toggle();
    });
    $('.battle_hero .icon-area').before(iconButton);
}
