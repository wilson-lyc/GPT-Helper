(function () {
  "use strict";

  const CONFIG = {
    MAX_TITLE_LENGTH: 40,
    TURN_SELECTOR: '[data-testid^="conversation-turn-"]',
    ROLE_SELECTOR: "[data-message-author-role]",
    ROOT_ID: "gpth-conversation-toc",
    ACTIVE_CLASS: "gpth-active",
    REBUILD_DELAY_MS: 180,
    PENDING_SCROLL_ATTEMPTS: 26,
    PENDING_SCROLL_DELAY_MS: 180,
    SCROLL_SETTLE_ATTEMPTS: 5,
    SCROLL_TARGET_TOLERANCE_PX: 24,
  };

  let root = null;
  let list = null;
  let activeTurnId = "";
  let turns = [];
  let rebuildTimer = 0;
  let mutationObserver = null;
  let intersectionObserver = null;
  let maxObservedQuestionNumber = 0;
  let lastConversationKey = "";
  let scrollJobId = 0;

  function init() {
    ensureRoot();
    rebuild();
    watchMutations();
  }

  function ensureRoot() {
    const existing = document.getElementById(CONFIG.ROOT_ID);
    if (existing) {
      root = existing;
      list = root.querySelector(".gpth-list");
      if (!list) {
        existing.remove();
        root = null;
        ensureRoot();
      } else {
        root.className = "";
      }
      return;
    }

    root = document.createElement("nav");
    root.id = CONFIG.ROOT_ID;
    root.setAttribute("aria-label", "ChatGPT user question navigation");

    list = document.createElement("ol");
    list.className = "gpth-list";

    root.append(list);
    document.documentElement.append(root);
  }

  function rebuild() {
    ensureRoot();
    turns = collectTurns();
    renderTurns(turns);
    watchIntersections(turns);
  }

  function collectTurns() {
    const conversationKey = getConversationKey();
    if (conversationKey !== lastConversationKey) {
      lastConversationKey = conversationKey;
      maxObservedQuestionNumber = 0;
      activeTurnId = "";
    }

    const turnNodes = Array.from(document.querySelectorAll(CONFIG.TURN_SELECTOR))
      .filter((turn) => !root || !root.contains(turn))
      .map((turn) => ({
        node: turn,
        turnNumber: getTurnNumber(turn)
      }))
      .filter((item) => item.turnNumber > 0);

    const loadedUsers = new Map();
    turnNodes
      .filter((item) => isUserTurn(item.node))
      .forEach((item) => {
        const questionNumber = getQuestionNumberFromTurnNumber(item.turnNumber);
        loadedUsers.set(questionNumber, toKnownTurnItem(item.node, item.turnNumber, questionNumber));
      });

    const maxTurnNumber = Math.max(0, ...turnNodes.map((item) => item.turnNumber));
    const maxQuestionNumber = Math.max(
      maxObservedQuestionNumber,
      loadedUsers.size ? Math.max(...loadedUsers.keys()) : 0,
      getQuestionNumberFromTurnNumber(maxTurnNumber)
    );
    maxObservedQuestionNumber = Math.max(maxObservedQuestionNumber, maxQuestionNumber);

    if (!maxQuestionNumber) {
      return Array.from(document.querySelectorAll(CONFIG.TURN_SELECTOR))
        .filter((turn) => !root || !root.contains(turn))
        .filter(isUserTurn)
        .map((turn, index) => toKnownTurnItem(turn, index + 1, index + 1))
        .filter(Boolean);
    }

    return Array.from({ length: maxQuestionNumber }, (_, index) => {
      const questionNumber = index + 1;
      return loadedUsers.get(questionNumber) || toPlaceholderTurnItem(questionNumber);
    });
  }

  function isUserTurn(turn) {
    const roleNode = turn.querySelector(CONFIG.ROLE_SELECTOR);
    return (
      (roleNode && roleNode.getAttribute("data-message-author-role") === "user") ||
      turn.getAttribute("data-turn") === "user"
    );
  }

  function toKnownTurnItem(turn, turnNumber, questionNumber) {
    const roleNode = turn.querySelector(CONFIG.ROLE_SELECTOR);
    const role = roleNode ? roleNode.getAttribute("data-message-author-role") : "";
    const textSource = roleNode || turn;
    const rawText = getReadableText(textSource);
    const id = ensureTurnId(turn, questionNumber);
    const label = rawText
      ? truncate(rawText, CONFIG.MAX_TITLE_LENGTH)
      : `提问 ${questionNumber}`;

    return {
      id,
      node: turn,
      label,
      role,
      index: questionNumber,
      turnNumber,
      known: true,
      hasTooltip: Boolean(rawText)
    };
  }

  function toPlaceholderTurnItem(questionNumber) {
    return {
      id: `gpth-question-${questionNumber}`,
      node: null,
      label: `提问 ${questionNumber}`,
      role: "user",
      index: questionNumber,
      turnNumber: getExpectedUserTurnNumber(questionNumber),
      known: false,
      hasTooltip: false
    };
  }

  function ensureTurnId(turn, questionNumber) {
    if (!turn.id) {
      turn.id = `gpth-question-${questionNumber}`;
    }

    return turn.id;
  }

  function getTurnNumber(turn) {
    const testId = turn.getAttribute("data-testid") || "";
    const match = testId.match(/^conversation-turn-(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  function getQuestionNumberFromTurnNumber(turnNumber) {
    return turnNumber > 0 ? Math.ceil(turnNumber / 2) : 0;
  }

  function getExpectedUserTurnNumber(questionNumber) {
    return questionNumber * 2 - 1;
  }

  function getConversationKey() {
    const match = window.location.pathname.match(/\/c\/[^/?#]+/);
    return match ? match[0] : window.location.pathname;
  }

  function getReadableText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll("script, style, svg, button, [aria-hidden='true']").forEach((el) => el.remove());

    return (clone.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function truncate(text, maxLength) {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1)}…`;
  }

  function renderTurns(items) {
    list.textContent = "";
    root.hidden = !items.length;

    if (!items.length) {
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "gpth-item";

      const button = document.createElement("button");
      button.className = "gpth-link";
      button.type = "button";
      button.dataset.turnId = item.id;
      button.dataset.questionIndex = String(item.index);
      button.dataset.known = String(item.known);
      button.setAttribute("aria-label", item.hasTooltip
        ? `跳转到用户提问 ${item.index}: ${item.label}`
        : `跳转到用户提问 ${item.index}`);
      button.addEventListener("click", () => scrollToTurn(item));

      const mark = document.createElement("span");
      mark.className = "gpth-mark";
      mark.setAttribute("aria-hidden", "true");

      if (item.hasTooltip) {
        const tooltip = document.createElement("span");
        tooltip.className = "gpth-tooltip";

        const question = document.createElement("span");
        question.className = "gpth-question";
        question.textContent = item.label;

        tooltip.append(question);
        button.append(tooltip);
      }

      const label = document.createElement("span");
      label.className = "gpth-label";
      label.textContent = item.label;

      button.append(mark, label);
      li.append(button);
      fragment.append(li);
    });

    list.append(fragment);

    const activeExists = items.some((item) => item.id === activeTurnId);
    const fallbackActiveId = items[items.length - 1].id;
    setActiveTurn(activeExists ? activeTurnId : fallbackActiveId);
  }

  function scrollToTurn(item) {
    const jobId = ++scrollJobId;
    setActiveTurn(item.id);
    scrollToQuestionByIndex(item.index, jobId, CONFIG.PENDING_SCROLL_ATTEMPTS);
  }

  function scrollToQuestionByIndex(questionNumber, jobId, attemptsLeft) {
    if (jobId !== scrollJobId || attemptsLeft <= 0) return;

    const target = findLoadedQuestion(questionNumber);
    if (target) {
      alignTarget(target, jobId, CONFIG.SCROLL_SETTLE_ATTEMPTS);
      return;
    }

    scrollToEstimatedQuestion(questionNumber, turns.length, attemptsLeft);
    window.setTimeout(() => {
      scrollToQuestionByIndex(questionNumber, jobId, attemptsLeft - 1);
    }, CONFIG.PENDING_SCROLL_DELAY_MS);
  }

  function setActiveTurn(id) {
    if (!id) return;
    activeTurnId = id;

    list.querySelectorAll(".gpth-link").forEach((button) => {
      button.classList.toggle(CONFIG.ACTIVE_CLASS, button.dataset.turnId === id);
    });
  }

  function watchIntersections(items) {
    if (intersectionObserver) {
      intersectionObserver.disconnect();
    }

    if (!items.length) return;

    intersectionObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

        if (visible && visible.target.id) {
          setActiveTurn(visible.target.id);
        }
      },
      {
        root: findScrollRoot(),
        rootMargin: "-15% 0px -65% 0px",
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1]
      }
    );

    items.forEach((item) => {
      if (item.node) {
        intersectionObserver.observe(item.node);
      }
    });
  }

  function findLoadedQuestion(questionNumber) {
    const expectedTurnNumber = getExpectedUserTurnNumber(questionNumber);
    const expectedTurn = document.querySelector(`[data-testid="conversation-turn-${expectedTurnNumber}"]`);
    if (expectedTurn && isUserTurn(expectedTurn)) {
      ensureTurnId(expectedTurn, questionNumber);
      return expectedTurn;
    }

    return Array.from(document.querySelectorAll(CONFIG.TURN_SELECTOR)).find((turn) => {
      return isUserTurn(turn) && getQuestionNumberFromTurnNumber(getTurnNumber(turn)) === questionNumber;
    }) || null;
  }

  function scrollToEstimatedQuestion(questionNumber, totalQuestions, attemptsLeft) {
    const scrollRoot = findScrollRoot() || document.scrollingElement || document.documentElement;
    if (!scrollRoot || totalQuestions <= 1) return;

    const ratio = (questionNumber - 1) / (totalQuestions - 1);
    const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    const currentTop = getScrollTop(scrollRoot);
    const targetTop = maxScrollTop * ratio;
    const distance = targetTop - currentTop;
    const shouldJump = attemptsLeft <= CONFIG.PENDING_SCROLL_ATTEMPTS - 2 || Math.abs(distance) > scrollRoot.clientHeight * 1.5;

    scrollRoot.scrollTo({
      top: shouldJump ? targetTop : currentTop + distance * 0.65,
      behavior: "auto"
    });
  }

  function alignTarget(target, jobId, attemptsLeft) {
    if (jobId !== scrollJobId || attemptsLeft <= 0) return;

    const questionNumber = getQuestionNumberFromTurnNumber(getTurnNumber(target));
    if (!target.isConnected) {
      const replacement = findLoadedQuestion(questionNumber);
      if (replacement) {
        alignTarget(replacement, jobId, attemptsLeft);
      }
      return;
    }

    const scrollRoot = findScrollRoot() || document.scrollingElement || document.documentElement;
    const offset = getTargetOffsetWithinScrollRoot(target, scrollRoot);

    if (Math.abs(offset) > CONFIG.SCROLL_TARGET_TOLERANCE_PX) {
      target.scrollIntoView({
        behavior: "auto",
        block: "start"
      });
    }

    rebuild();
    setActiveTurn(`gpth-question-${questionNumber}`);

    window.setTimeout(() => {
      alignTarget(target, jobId, attemptsLeft - 1);
    }, 120);
  }

  function getScrollTop(scrollRoot) {
    if (scrollRoot === document.documentElement || scrollRoot === document.body || scrollRoot === document.scrollingElement) {
      return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }

    return scrollRoot.scrollTop;
  }

  function getTargetOffsetWithinScrollRoot(target, scrollRoot) {
    const targetTop = target.getBoundingClientRect().top;
    if (!scrollRoot || scrollRoot === document.documentElement || scrollRoot === document.body || scrollRoot === document.scrollingElement) {
      return targetTop;
    }

    return targetTop - scrollRoot.getBoundingClientRect().top;
  }

  function findScrollRoot() {
    const main = document.getElementById("main");
    const scrollRoot = main && findAncestorByClass(main, "group/scroll-root");
    if (scrollRoot) return scrollRoot;

    const thread = document.getElementById("thread");
    const parent = thread && findScrollableParent(thread);
    return parent || null;
  }

  function findAncestorByClass(node, className) {
    let current = node;
    while (current && current !== document.body) {
      if (current.classList && current.classList.contains(className)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function findScrollableParent(node) {
    let current = node.parentElement;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function watchMutations() {
    if (mutationObserver) {
      mutationObserver.disconnect();
    }

    mutationObserver = new MutationObserver((mutations) => {
      if (!shouldHandleMutations(mutations)) return;
      scheduleRebuild();
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function shouldHandleMutations(mutations) {
    return mutations.some((mutation) => {
      const target = mutation.target;
      if (root && target instanceof Node && root.contains(target)) {
        return false;
      }

      return true;
    });
  }

  function scheduleRebuild() {
    window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(rebuild, CONFIG.REBUILD_DELAY_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

})();
