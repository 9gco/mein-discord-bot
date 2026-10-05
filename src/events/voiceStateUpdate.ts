import {
  Events,
  type Client,
  type Guild,
  type GuildMember,
  type VoiceState,
} from "discord.js";
import { logger } from "../utils/logger.js";
import {
  abortableDelay,
  applyQueueNickname,
  clearCooldown,
  connectToVerifyChannel,
  cooldownRemaining,
  dequeueWaiting,
  enqueueWaiting,
  fetchTtsChunks,
  getVerifyConfig,
  isMemberInChannel,
  isWaiting,
  logVerifyPermissions,
  peekFirstEligible,
  playBuffers,
  renumberWaiting,
  runExclusive,
  runMicCheck,
  setCooldown,
  spokenName,
  stripQueueNickname,
  throwIfAborted,
  waitForMemberInChannel,
  waitForSilence,
  VerifyAbortedError,
  WAITING_CHANNEL_ID,
  type MicCheckReason,
  type MicCheckResult,
  type VerifyConfig,
  VERIFIED_ROLE_ID,
} from "../utils/verify.js";
import type { BotEvent } from "./index.js";

/** Mitglieder, die gerade geprüft werden – verhindert Doppel-Starts. */
const busy = new Set<string>();
/** Pro Guild: läuft bereits eine Prüfung? */
const activeGuild = new Map<string, string>();
/**
 * Laufende Prüf-Durchläufe mit Abbruch-Hebel. Verlässt ein Mitglied den Kanal,
 * wird hierüber der laufende Durchlauf sofort beendet – sonst wartet der Bot
 * noch bis zu 45 Sekunden auf Mikrofon-Sprache und die Schlange steht still.
 */
const running = new Map<string, AbortController>();

function busyKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/** Bricht einen laufenden Durchlauf ab, falls es einen gibt. */
function abortRun(guildId: string, userId: string): boolean {
  const controller = running.get(busyKey(guildId, userId));
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Kurz pause, damit der Nutzer nach der Ansage losreden kann. */
const MIC_START_DELAY_MS = 1_200;

/**
 * So lange wird nach dem Move gewartet, bis das Mitglied wirklich im
 * Prüf-Kanal steht und Audio empfängt. Danach wird ohne Ansage aufgegeben –
 * der Bot redet nicht in einen Kanal, in dem niemand zuhört.
 */
const MEMBER_JOIN_TIMEOUT_MS = 30_000;

/**
 * Schonzeit nach erfolgreichem Check, bevor der Bot das Mitglied aus dem Call
 * holt. Ohne sie wirkt das Trennen wie eine Strafe – die Erfolgsansage ist
 * gerade erst zu Ende, die Rollen noch nicht sichtbar.
 */
const MIC_PASS_GRACE_MS = 3_000;

/**
 * Ansage direkt vor dem Trennen. Wer weiß, dass er gleich rausgeholt wird,
 * empfindet es nicht als Rauswurf – die Channels sind ab da frei.
 */
const MIC_PASS_DISCONNECT_MESSAGE =
  "Sehr gut, damit bist du durch. Vielen Dank für deine Geduld " +
  "und viel Spaß auf unserem Server.";

/**
 * Wie viele Prüfversuche ein Mitglied im Prüf-Kanal bekommt, bevor es in die
 * Wartezeit muss. Die meisten Fehler sind Einstellungsprobleme, die sich
 * direkt korrigieren lassen – deshalb zwei zusätzliche Versuche.
 */
const MIC_MAX_ATTEMPTS = 3;

/**
 * Wartezeit nach dem letzten Fehlversuch. Das Mitglied bleibt dabei einfach in
 * der Warteschlange, wird aber übersprungen, während die Zeit läuft – so
 * blockiert es niemanden.
 */
const MIC_COOLDOWN_MS = 60_000;

/**
 * Spielt eine Ansage – aber nur, wenn das Mitglied wirklich im Prüf-Kanal ist
 * und den Stream auch empfangen kann. Andernfalls bricht der Durchlauf ab,
 * statt in einen leeren Kanal zu reden: der Bot redet erst, wenn der
 * Wartende wirklich zuhört.
 */
async function speak(
  guild: Guild,
  channelId: string,
  text: string,
  voice: string,
  memberId: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!isMemberInChannel(guild, memberId, channelId)) {
    throw new VerifyAbortedError(
      "Mitglied ist nicht (mehr) im Prüf-Kanal – Ansage entfällt.",
    );
  }
  const connection = await connectToVerifyChannel(guild, channelId);
  if (!connection) {
    logger.error("Keine Voice-Verbindung – Ansage entfällt.", {
      guildId: guild.id,
      channelId,
    });
    return;
  }
  // Erst warten, bis niemand spricht, sonst redet der Bot mitten im Satz rein.
  await waitForSilence(connection, 700, 60_000, signal);
  throwIfAborted(signal);
  // Nach der Stillepause kann das Mitglied den Kanal verlassen haben.
  if (!isMemberInChannel(guild, memberId, channelId)) {
    throw new VerifyAbortedError(
      "Mitglied hat den Prüf-Kanal während der Wartezeit verlassen.",
    );
  }
  const buffers = await fetchTtsChunks(text, voice);
  throwIfAborted(signal);
  await playBuffers(connection, buffers, signal);
  throwIfAborted(signal);
}

/**
 * Gibt den Warteschlangen-Slot wieder frei und rückt die Nummern nach.
 * Nötig, wenn ein Durchlauf früh abbricht – sonst bleibt der Slot vorne
 * stehen und der nächste Start versucht immer denselben Kandidaten.
 *
 * Reihenfolge wichtig: erst den Nickname zurücksetzen, dann den Eintrag löschen.
 * `stripQueueNickname` braucht den Eintrag, um den Originalnamen zu kennen.
 */
async function releaseQueueSlot(guild: Guild, member: GuildMember): Promise<void> {
  await stripQueueNickname(guild, member.id);
  dequeueWaiting(guild.id, member.id);
  await renumberWaiting(guild);
}

/**
 * Vergibt die konfigurierten Rollen und prüft danach einmal nach, ob sie
 * wirklich gesetzt sind. Ein Rollenfehler darf nicht still durchrutschen:
 * der Bot trennt das Mitglied danach aus dem Call, und ohne Rolle wäre das
 * Rauswerfen eine Strafe ohne Gegenwert.
 *
 * Gibt zurück, ob alle Rollen am Ende wirklich gesetzt sind.
 */
async function grantVerifyRoles(
  guild: Guild,
  member: GuildMember,
  roleIds: string[],
): Promise<boolean> {
  if (roleIds.length === 0) {
    logger.warn(
      "Keine Verify-Rollen konfiguriert – Mitglied bleibt ohne Rolle.",
      { guildId: guild.id, userId: member.id },
    );
    return false;
  }

  const missing = roleIds.filter((roleId) => !member.roles.cache.has(roleId));
  if (missing.length === 0) return true;

  try {
    await member.roles.add(missing, "Automatische Verifizierung");
  } catch (err) {
    logger.error("Verify-Rollen konnten nicht vergeben werden.", {
      guildId: guild.id,
      userId: member.id,
      roleIds: missing,
      error: err,
    });
  }

  // `roles.add` aktualisiert den Cache – falls doch etwas fehlt, einmal nach
  // dem Gateway-Stand fragen, bevor der Bot das Mitglied rausholt.
  const stillMissing = missing.filter((roleId) => !member.roles.cache.has(roleId));
  if (stillMissing.length > 0) {
    logger.error("Verify-Rollen fehlen trotz Vergabeversuch.", {
      guildId: guild.id,
      userId: member.id,
      roleIds: stillMissing,
    });
    return false;
  }

  logger.info("Verify-Rollen vergeben.", {
    guildId: guild.id,
    userId: member.id,
    roleIds: missing,
  });
  return true;
}

/**
 * Übersetzt ein Messergebnis in einen Satz, den der Bot vorlesen kann. Der Text
 * nennt den konkreten Grund, damit das Mitglied weiß, was es ändern muss.
 *
 * Ton wie bei einem Moderator im Voice-Chat: sachlich, aber nicht kalt. Keine
 * Messwerte - "es liegen 0,8 Sekunden Sprechzeit vor" sagt niemandem etwas,
 * "der Test war zu kurz" schon. Und kein Kommentar über die Technik dahinter:
 * "bei mir kam nichts an" statt "ich habe aus deinem Mikrofon keinen Ton
 * bekommen".
 */
function describeMicProblem(reason: MicCheckReason): string {
  switch (reason) {
    case "no_speech":
      return "Von deinem Mikrofon ist bei mir überhaupt nichts angekommen.";
    case "too_short":
      return "Der Test war etwas zu kurz. Bitte rede ein wenig länger, damit ich dich richtig einschätzen kann.";
    case "clipping":
      return "Dein Mikrofon ist übersteuert, die Stimme verzerrt. Bitte reduziere die Eingabelautstärke oder den Mikrofon-Gain etwas.";
    case "noisy":
      return "Bei dir ist sehr viel Hintergrundgeräusch, wodurch ich dich nur schwer verstehen kann. Ein ruhigerer Raum wäre die bessere Wahl.";
    case "too_quiet":
      return "Dein Mikrofon ist sehr leise, ich kann dich kaum verstehen. Bitte erhöhe die Eingabelautstärke etwas.";
    case "error":
    default:
      return "Bei der Durchführung des Tests ist leider ein technischer Fehler aufgetreten. Bitte versuche es gleich noch einmal.";
  }
}

/**
 * Vollständiger Prüf-Durchlauf für ein Mitglied:
 * in den Prüf-Kanal ziehen → Ansage → Mikrofon-Check (bis zu
 * `MIC_MAX_ATTEMPTS` Versuche) → Ergebnis melden → Wartezeit bei Fehlschlag →
 * aus dem Call entfernen.
 *
 * Der Bot ändert keine Kanalrechte. Die Rechte im Prüf-Kanal werden
 * komplett von Hand in Discord gesetzt: `@everyone` hat dort weder
 * "Kanäle ansehen" noch "Verbinden" (so kommt niemand selbst hinein),
 * "Senden" ist offen (damit die Wartenden nach dem Move reden können).
 * Der Bot braucht dafür nur "Move Members". Auch das Sprechrecht wird
 * nicht geschaltet: das Mitglied kann durchgehend reden.
 */
async function runVerify(
  guild: Guild,
  member: GuildMember,
  cfg: VerifyConfig,
  signal: AbortSignal,
): Promise<void> {
  const verifyChannelId = cfg.channelId;
  if (!verifyChannelId) {
    await releaseQueueSlot(guild, member);
    return;
  }

  // 1) Der Bot aendert an den Rechten nichts. Die Rechte im Prüf-Kanal werden
  //    von Hand in Discord gesetzt. Wir schauen nur nach, was gerade gilt –
  //    rein lesend, damit ein Problem im Log sichtbar wird.
  logVerifyPermissions(guild, verifyChannelId, member.id);

  // 2) Aus dem Warteraum in den Prüf-Kanal holen. Discord erlaubt das auch
  //    dann, wenn @everyone dort kein "Kanäle ansehen"/"Verbinden" hat –
  //    nötig ist nur "Move Members" für den Bot. Damit kann sich niemand
  //    selbst eintragen, der Bot zieht seine Wartenden aber hinein.
  if (member.voice.channelId !== verifyChannelId) {
    try {
      await member.voice.setChannel(verifyChannelId);
    } catch (err) {
      logger.error(
        "Mitglied konnte nicht in den Prüf-Kanal bewegt werden. Der Bot " +
          "braucht 'Move Members' und im Prüf-Kanal muss 'Senden' für " +
          "@everyone erlaubt sein, damit das Mitglied dort reden kann.",
        {
          guildId: guild.id,
          userId: member.id,
          channelId: verifyChannelId,
          error: err,
        },
      );
      await releaseQueueSlot(guild, member);
      return;
    }
  }

  // 3) Im Prüf-Kanal zählt der echte Name, die "(n) "-Nummer fällt weg und
  //    wird auch nicht vorgelesen.
  await stripQueueNickname(guild, member.id);

  // 4) Warten, bis das Mitglied wirklich angekommen ist. Nach dem Move hat
  //    Discord nur bestätigt, dass der Umzug durch ist – der Client des
  //    Mitglieds baut die Voice-Verbindung erst noch auf. Ohne diese Wartezeit
  //    startet die Ansage, während der Wartende noch verbindet, und die ersten
  //    Sekunden gehen verloren.
  const arrived = await waitForMemberInChannel(
    guild,
    member.id,
    verifyChannelId,
    MEMBER_JOIN_TIMEOUT_MS,
    signal,
  );
  if (!arrived) {
    throwIfAborted(signal);
    logger.info("Mitglied nicht angekommen – Durchlauf ohne Ansage beendet.", {
      guildId: guild.id,
      userId: member.id,
      channelId: verifyChannelId,
    });
    await releaseQueueSlot(guild, member);
    return;
  }

  const connection = await connectToVerifyChannel(guild, verifyChannelId);
  if (!connection) {
    logger.error("Konnte dem Prüf-Kanal nicht beitreten.", {
      guildId: guild.id,
      channelId: verifyChannelId,
    });
    await releaseQueueSlot(guild, member);
    return;
  }

  const name = spokenName(member.displayName);
  /** Wird im `finally` ausgewertet, um das Aufräumen zu protokollieren. */
  let passed = false;

  try {
    // 5) Begrüßung mit der Check-Aufforderung.
    await speak(
      guild,
      verifyChannelId,
      cfg.message.replace(/\{user\}/g, name),
      cfg.voice,
      member.id,
      signal,
    );

    // 6) Mehrere Versuche direkt nacheinander. Die meisten Fehler sind
    //    Einstellungsprobleme, die sich sofort korrigieren lassen.
    let lastResult: MicCheckResult | undefined;

    for (let attempt = 1; attempt <= MIC_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await speak(
          guild,
          verifyChannelId,
          "Kein Problem, wir führen den Test noch einmal durch.",
          cfg.voice,
          member.id,
          signal,
        );
      }

      // Das Sprechrecht gilt dauerhaft, es wird nicht zu- und abgeschaltet.
      // Der Bot sagt nur noch kurz Bescheid, ab wann es losgehen kann.
      await speak(
        guild,
        verifyChannelId,
        cfg.speakNowMessage.replace(/\{user\}/g, name),
        cfg.voice,
        member.id,
        signal,
      );
      throwIfAborted(signal);

      // Kurz Luft lassen, damit der Nutzer direkt losreden kann. Hier bewusst
      // KEIN Warten auf Stille – sonst würde eine sofort begonnene Antwort
      // vergehen, weil wir erst auf ihr Ende warten würden. Der Mic-Check
      // wartet von sich aus bis zu MIC_MAX_WAIT_MS auf den ersten Ton.
      await abortableDelay(MIC_START_DELAY_MS, signal);
      const result = await runMicCheck(connection, member.id, signal);

      // Abbruch? Dann nichts mehr ansagen, der Durchlauf ist vorbei.
      if (result.reason === "aborted") return;

      lastResult = result;

      logger.info(`Mikrofon-Check Versuch ${attempt}/${MIC_MAX_ATTEMPTS}.`, {
        guildId: guild.id,
        userId: member.id,
        ok: result.ok,
        reason: result.reason,
        speechMs: result.speechMs,
        level: result.level,
        peak: result.peak,
        snr: result.snr,
      });

      if (result.ok) {
        passed = true;
        break;
      }

      // Grund nennen, aber erst nach dem letzten Versuch die Zusatzanweisung.
      // reason ist nur gesetzt, wenn die Prüfung gescheitert ist. Fehlt er, ist
// etwas Unerwartetes passiert - dann passt die technische Floskel.
const problem = describeMicProblem(result.reason ?? "error");
      const isLast = attempt === MIC_MAX_ATTEMPTS;
      await speak(
        guild,
        verifyChannelId,
        isLast
          ? `${problem} ${cfg.micFailedMessage.replace(/\{user\}/g, name)}`
          : problem,
        cfg.voice,
        member.id,
        signal,
      );
    }

    if (passed) {
      // 7a) Erfolg: Ergebnis melden, dauerhafte Rollen geben, Wartezeit lösen.
      await speak(
        guild,
        verifyChannelId,
        cfg.micPassedMessage.replace(/\{user\}/g, name),
        cfg.voice,
        member.id,
        signal,
      );

      await grantVerifyRoles(guild, member, cfg.roles);
      clearCooldown(guild.id, member.id);

      // Erst jetzt wird das Mitglied aus dem Call geholt: Ansage ist
      // ausgesprochen und die Rollen stehen. Vorher wirkt das Trennen wie
      // eine Strafe, weil die Freigabe noch gar nicht angekommen ist.
      await speak(
        guild,
        verifyChannelId,
        MIC_PASS_DISCONNECT_MESSAGE,
        cfg.voice,
        member.id,
        signal,
      );
      await abortableDelay(MIC_PASS_GRACE_MS, signal);
    } else {
      // 6b) Alle Versuche durch: Wartezeit setzen, damit die Schlange
      //     weiterläuft. Wer in der Zwischenzeit wieder in den Warteraum
      //     kommt, wird solange übersprungen.
      const seconds = Math.ceil(MIC_COOLDOWN_MS / 1000);
      setCooldown(guild.id, member.id, MIC_COOLDOWN_MS);
      logger.info("Wartezeit nach Fehlschlag gesetzt.", {
        guildId: guild.id,
        userId: member.id,
        reason: lastResult?.reason,
        cooldownMs: MIC_COOLDOWN_MS,
      });
      // Wecker, damit die Schlange weiterläuft, sobald die Zeit abgelaufen
      // ist – VoiceStateUpdate feuert dafür nicht.
      const timer = setTimeout(
        () => {
          void getVerifyConfig(guild.id).then((latest) => {
            startNextIfIdle(guild, latest);
          });
        },
        MIC_COOLDOWN_MS + 500,
      );
      // Der Timer darf den Prozess nicht am Leben halten.
      timer.unref?.();
      await speak(
        guild,
        verifyChannelId,
        `Komm bitte in ${seconds} Sekunden noch einmal in den Warteraum, ` +
          `dann versuchen wir es erneut.`,
        cfg.voice,
        member.id,
        signal,
      );
    }
  } catch (err) {
    // Vorzeitiges Verlassen ist kein Fehler, sondern der Normalfall.
    if (err instanceof VerifyAbortedError) {
      logger.info("Prüfung abgebrochen – Mitglied ist nicht (mehr) im Kanal.", {
        guildId: guild.id,
        userId: member.id,
        reason: err.message,
      });
    } else {
      logger.error("Prüf-Durchlauf fehlgeschlagen.", {
        guildId: guild.id,
        userId: member.id,
        error: err,
      });
    }
  } finally {
    // 7) Keine Rechte aufraeumen - es wurden keine gesetzt.
    // Nickname immer zurücksetzen – auch bei Abbruch. Wer den Kanal
    // verlassen hat, darf nicht mit "(1) " dastehen bleiben.
    await stripQueueNickname(guild, member.id);
    dequeueWaiting(guild.id, member.id);
    // Die Nummern der Wartenden rücken nach.
    await renumberWaiting(guild);
    // 8) Aus dem Call entfernen – aber nur, wenn das Mitglied auch wirklich
    //    noch im Prüf-Kanal ist. Wer inzwischen woanders unterwegs ist, wird
    //    nicht zusätzlich aus seinem neuen Kanal gerissen.
    if (isMemberInChannel(guild, member.id, verifyChannelId)) {
      logger.info("Mitglied wird aus dem Prüf-Kanal geholt.", {
        guildId: guild.id,
        userId: member.id,
        passed,
      });
      await member.voice.setChannel(null).catch(() => undefined);
    }
  }
}

/**
 * Startet die Prüfung des nächsten Wartenden, falls noch keiner läuft. Wer noch
 * in der Wartezeit ist, wird übersprungen – so blockiert ein fehlgeschlagenes
 * Mikrofon nicht die ganze Schlange.
 */
function startNextIfIdle(guild: Guild, cfg: VerifyConfig): void {
  if (activeGuild.has(guild.id)) return;
  const next = peekFirstEligible(
    guild.id,
    (userId) => cooldownRemaining(guild.id, userId) === 0,
  );
  if (!next) return;

  const member = guild.members.cache.get(next.userId);
  if (!member) {
    // Mitglied hat den Server verlassen – Eintrag verwerfen und weiter.
    dequeueWaiting(guild.id, next.userId);
    startNextIfIdle(guild, cfg);
    return;
  }

  const key = busyKey(guild.id, next.userId);
  if (busy.has(key)) return;

  busy.add(key);
  activeGuild.set(guild.id, next.userId);
  const controller = new AbortController();
  running.set(key, controller);

  void runExclusive(guild.id, async () => {
    try {
      // `runExclusive` stellt Durchläufe hintereinander, es kann also Sekunden
      // dauern, bis dieser Start drankommt. In der Zeit kann das Mitglied den
      // Warteraum verlassen haben – dann wurde sein Eintrag schon entfernt.
      // Ohne diese Prüfung würde der Bot in den Prüf-Kanal ziehen und dort
      // ansprechen, obwohl niemand mehr wartet.
      const current = guild.members.cache.get(next.userId);
      const stillQueued = isWaiting(guild.id, next.userId);
      const waitingId = cfg.waitingChannelId || WAITING_CHANNEL_ID;
      const stillInChannel =
        current !== undefined &&
        (current.voice.channelId === waitingId ||
          current.voice.channelId === cfg.channelId);

      if (!current || !stillQueued || !stillInChannel) {
        logger.info("Start übersprungen – Mitglied ist nicht mehr am Start.", {
          guildId: guild.id,
          userId: next.userId,
          stillQueued,
          stillInChannel,
          channelId: current?.voice.channelId,
        });
        if (stillQueued) {
          // Eintrag noch vorhanden, aber das Mitglied ist weg: aufräumen.
          await stripQueueNickname(guild, next.userId);
          dequeueWaiting(guild.id, next.userId);
          await renumberWaiting(guild);
        }
        return;
      }

      await runVerify(guild, current, cfg, controller.signal);
    } finally {
      busy.delete(key);
      running.delete(key);
      if (activeGuild.get(guild.id) === next.userId) activeGuild.delete(guild.id);
      startNextIfIdle(guild, cfg);
    }
  });
}

/**
 * Nach einem Neustart: alle, die noch im Warteraum hängen, wieder einreihen und
 * die Prüfung starten. Ohne das würde nach einem Deploy niemand mehr aufgerufen,
 * weil VoiceStateUpdate nur bei Kanalwechseln feuert.
 *
 * Die ursprüngliche Beitrittsreihenfolge lässt sich nach einem Neustart nicht
 * wiederherstellen – discord.js liefert keinen Zeitstempel dafür. Wir nehmen
 * daher die Reihenfolge, in der die Voice-States im Cache liegen.
 */
export async function resumeVerifyQueue(client: Client<true>): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      const cfg = await getVerifyConfig(guild.id);
      if (!cfg.enabled || !cfg.channelId) continue;

      const waitingChannelId = cfg.waitingChannelId || WAITING_CHANNEL_ID;
      const channel = guild.channels.cache.get(waitingChannelId);
      if (!channel?.isVoiceBased()) continue;

      const userIds = [...guild.voiceStates.cache.values()]
        .filter((state) => state.channelId === waitingChannelId)
        .map((state) => state.id);

      if (userIds.length === 0) {
        startNextIfIdle(guild, cfg);
        continue;
      }

      const waiting = (
        await guild.members.fetch({ user: userIds })
      ).values();

      let count = 0;
      for (const member of waiting) {
        if (member.user.bot) continue;
        if (member.voice.channelId !== waitingChannelId) continue;
        if (cfg.roles.some((roleId) => member.roles.cache.has(roleId))) continue;
        const position = enqueueWaiting(
          guild.id,
          member.id,
          member.nickname,
          member.displayName,
        );
        await applyQueueNickname(guild, member.id, position);
        count++;
      }

      if (count > 0) {
        logger.info("Warteschlange nach Neustart wiederhergestellt.", {
          guildId: guild.id,
          count,
        });
      }
      startNextIfIdle(guild, cfg);
    } catch (err) {
      logger.error("Warteschlange konnte nicht wiederhergestellt werden.", {
        guildId: guild.id,
        error: err,
      });
    }
  }
}

const event: BotEvent<Events.VoiceStateUpdate> = {
  name: Events.VoiceStateUpdate,

  async execute(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guild = newState.guild;
    if (!guild) return;

    // Nur echte Mitglieder, keine Bots.
    if (newState.member?.user.bot) return;

    // Mute/Unmute und reine Rechtewechsel ignorieren – nur Kanalwechsel
    // interessieren uns.
    if (oldState.channelId === newState.channelId) return;

    const cfg = await getVerifyConfig(guild.id);
    if (!cfg.enabled) return;

    const member = newState.member;
    if (!member) return;

    const waitingChannelId = cfg.waitingChannelId || WAITING_CHANNEL_ID;
    const verifyChannelId = cfg.channelId;
    if (!verifyChannelId) return;

    // Bereits verifiziert → ignorieren.
    if (cfg.roles.some((roleId) => member.roles.cache.has(roleId))) return;
    // Hat bereits die Verifizieren-Rolle → sofort aus Warteraum werfen
    // und Schlange weiterschieben.
    if (member.roles.cache.has(VERIFIED_ROLE_ID)) {
      if (newState.channelId === waitingChannelId) {
        try {
          await member.voice.disconnect(
            "Bereits verifiziert (Verifizieren-Rolle vorhanden)",
          );
        } catch {}
      }
      if (oldState.channelId === waitingChannelId) {
        await stripQueueNickname(guild, member.id);
        dequeueWaiting(guild.id, member.id);
        await renumberWaiting(guild);
        startNextIfIdle(guild, cfg);
      }
      return;
    }

    const key = busyKey(guild.id, member.id);

    // 0) Hat den Kanal verlassen – auch per Disconnect, bei dem channelId
    //    auf null fällt. Ohne diesen Zweig bleiben Nickname und Queue-Eintrag
    //    zurück und niemand wird mehr aufgerufen.
    const leftVerify = oldState.channelId === verifyChannelId;
    const leftWaiting =
      oldState.channelId === waitingChannelId && oldState.channelId !== verifyChannelId;

    if (!newState.channelId && (leftVerify || leftWaiting || busy.has(key))) {
      const aborted = abortRun(guild.id, member.id);
      // Ein laufender Durchlauf räumt in seinem finally selbst auf. Wer nur in der
      // Warteschlange stand, muss hier entfernt werden.
      if (!aborted) {
        await stripQueueNickname(guild, member.id);
        dequeueWaiting(guild.id, member.id);
        await renumberWaiting(guild);
      }
      logger.info("Mitglied hat den Kanal verlassen – Eintrag aufgeräumt.", {
        guildId: guild.id,
        userId: member.id,
        wasVerifying: leftVerify,
        aborted,
      });
      return;
    }

    // 1) Beitritt in den Warteraum: Platz in der Schlange sichern, Namen
    //    mit der Wartenummer versehen und – falls nichts wartet – starten.
    if (newState.channelId === waitingChannelId && oldState.channelId !== verifyChannelId) {
      if (busy.has(key)) return;
      const position = enqueueWaiting(
        guild.id,
        member.id,
        member.nickname,
        member.displayName,
      );
      await applyQueueNickname(guild, member.id, position);
      logger.info("Mitglied in der Warteschlange.", {
        guildId: guild.id,
        userId: member.id,
        position,
      });
      startNextIfIdle(guild, cfg);
      return;
    }

    // 2) Direkter Beitritt in den Prüf-Kanal: ebenfalls einreihen und prüfen.
    if (newState.channelId === verifyChannelId) {
      if (busy.has(key)) return;
      const position = enqueueWaiting(
        guild.id,
        member.id,
        member.nickname,
        member.displayName,
      );
      await applyQueueNickname(guild, member.id, position);
      startNextIfIdle(guild, cfg);
      return;
    }

    // 3) Aus dem Prüf-Kanal in einen anderen Kanal gewechselt: laufende Prüfung
    //    abbrechen. Der Nickname wird im finally des Durchlaufs zurückgesetzt,
    //    außer der Durchlauf kam nie zustande.
    if (leftVerify) {
      const aborted = abortRun(guild.id, member.id);
      if (!aborted) {
        await stripQueueNickname(guild, member.id);
        dequeueWaiting(guild.id, member.id);
      }
      await renumberWaiting(guild);
      logger.info("Prüfung verlassen – abgebrochen.", {
        guildId: guild.id,
        userId: member.id,
        toChannelId: newState.channelId,
        aborted,
      });
      return;
    }

    // 4) Aus dem Warteraum in einen anderen Kanal: nicht mehr warten.
    if (leftWaiting && newState.channelId !== waitingChannelId) {
      await stripQueueNickname(guild, member.id);
      dequeueWaiting(guild.id, member.id);
      await renumberWaiting(guild);
      logger.info("Aus der Warteschlange gegangen – Eintrag entfernt.", {
        guildId: guild.id,
        userId: member.id,
      });
    }
  },
};

export default event;