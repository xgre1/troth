// SPDX-License-Identifier: AGPL-3.0-only
// Agent Communication Protocol (Lite) — JSON-RPC over HTTP for cross-agent messaging.
//
// Research [Proxy]: Full ACP has 4 layers (Transport/Semantic/Negotiation/
// Governance). Lite version: simple message bus where multiple troth
// instances or agents can publish/subscribe to events.
//
// Used for: coordinating multiple troth runs, broadcasting workflow state
// changes, sharing reflexion lessons across instances.

const events = []; // [{ topic, payload, ts }]
const subscribers = new Map(); // topic → [callback]
const MAX_EVENTS = 100;

function publish(topic, payload) {
  const event = { topic, payload, ts: Date.now() };
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
  const subs = subscribers.get(topic) || [];
  for (const cb of subs) {
    try { cb(payload); } catch (e) {}
  }
  // Wildcard subscribers
  const wildcard = subscribers.get('*') || [];
  for (const cb of wildcard) {
    try { cb({ topic, payload }); } catch (e) {}
  }
}

function subscribe(topic, callback) {
  if (!subscribers.has(topic)) subscribers.set(topic, []);
  subscribers.get(topic).push(callback);
  return () => { // unsubscribe
    const subs = subscribers.get(topic) || [];
    const idx = subs.indexOf(callback);
    if (idx >= 0) subs.splice(idx, 1);
  };
}

function getRecentEvents(topic, limit) {
  limit = limit || 20;
  const filtered = topic ? events.filter(e => e.topic === topic) : events;
  return filtered.slice(-limit);
}

module.exports = { publish, subscribe, getRecentEvents };
