let fetch;
let AsyncStorage;
const FLAGSMITH_KEY = "BULLET_TRAIN_DB";
const FLAGSMITH_EVENT = "BULLET_TRAIN_EVENT";
const defaultAPI = 'https://api.bullet-train.io/api/v1/';
const deepEqual = require('fast-deep-equal');

const initError = function (caller) {
    return "Attempted to " + caller + " a user before calling flagsmith.init. Call flagsmith.init first, if you wish to prevent it sending a request for flags, call init with preventFetch:true."
}

const Flagsmith = class {

    constructor(props) {
        if (props.fetch) {
            fetch = props.fetch;
        } else {
            fetch = global.fetch;
        }
        AsyncStorage = props.AsyncStorage;
    }

    getJSON = (url, method, body) => {
        const { environmentID } = this;
        const options = {
            method: method || 'GET',
            body,
            headers: {
                'x-environment-key': environmentID
            }
        };
        if (method !== "GET")
            options.headers['Content-Type'] = 'application/json; charset=utf-8'
        return fetch(url, options)
            .then(res => {
                if (res.status >= 200 && res.status < 300) {
                    return res;
                }
                return res.text()
                    .then((res) => {
                        let err = res;
                        try {
                            err = JSON.parse(res);
                        } catch (e) {
                        }
                        return Promise.reject(err);
                    })
            })
            .then(res => res.json());
    };

    getFlags = (resolve, reject) => {
        const { onChange, onError, identity, api, disableCache } = this;
        let resolved = false;
        const handleResponse = ({ flags: features, traits }, segments) => {
            // Handle server response
            let flags = {};
            let userTraits = {};
            features = features || [];
            traits = traits || [];
            features.forEach(feature => {
                flags[feature.feature.name.toLowerCase().replace(/ /g, '_')] = {
                    id: feature.feature.id,
                    enabled: feature.enabled,
                    value: feature.feature_state_value
                };
            });
            traits.forEach(trait => {
                userTraits[trait.trait_key.toLowerCase().replace(/ /g, '_')] = trait.trait_value
            });
            this.oldFlags = {
                ...this.flags
            };
            if (segments) {
                let userSegments = {};
                segments.map((s) => {
                    userSegments[s.name] = s;
                });
                this.segments = userSegments;
            }
            const flagsEqual = deepEqual(this.flags, flags);
            const traitsEqual = deepEqual(this.traits, userTraits);
            this.flags = flags;
            this.traits = userTraits;
            this.updateStorage();
            if (onChange) {
                onChange(this.oldFlags, {
                    isFromServer: true,
                    flagsChanged: !flagsEqual,
                    traitsChanged: !traitsEqual
                });
            }
        };

        if (identity) {
            return Promise.all([
                this.getJSON(api + 'identities/?identifier=' + encodeURIComponent(identity)),
            ])
                .then((res) => {
                    handleResponse(res[0], res[1])
                }).catch(({ message }) => {
                    onError && onError({ message })
                });
        } else {
            return Promise.all([
                this.getJSON(api + "flags/")
            ])
                .then((res) => {
                    handleResponse({ flags: res[0] }, null)
                    if (resolve && !resolved) {
                        resolved = true;
                        resolve();
                    }
                }).catch((err) => {
                    if (reject && !resolved) {
                        resolved = true;
                        reject(err);
                    }
                    onError && onError(err)
                });
        }
    };

    analyticsFlags = () => {
        const { api, evaluationEvent } = this;
        if (evaluationEvent) {
            return Promise.all([
                this.getJSON(api + 'analytics/', 'POST', JSON.stringify(evaluationEvent)),
            ]).then(() => {
                this.evaluationEvent = {};
                this.updateEventStorage();
            }).catch();
        }
    };

    init({
        environmentID,
        api = defaultAPI,
        onChange,
        cacheFlags,
        onError,
        defaultFlags,
        preventFetch,
        enableLogs,
        sendFlagEvaluationEvents,
        AsyncStorage: _AsyncStorage,
        state
    }) {

        return new Promise((resolve, reject) => {
            this.environmentID = environmentID;
            this.api = api;
            this.interval = [];
            this.onChange = onChange;
            this.onError = onError;
            this.enableLogs = enableLogs;
            this.sendFlagEvaluationEvents = sendFlagEvaluationEvents ? sendFlagEvaluationEvents : false;
            this.flags = Object.assign({}, defaultFlags) || {};
            this.initialised = true;
            this.timer = this.enableLogs ? new Date().valueOf() : null;
            if (_AsyncStorage) {
                AsyncStorage = _AsyncStorage;
            }
            this.cacheFlags = typeof AsyncStorage !== 'undefined' && cacheFlags;
            this.setState(state)
            if (!environmentID) {
                reject('Please specify a environment id')
                throw ('Please specify a environment id');
            }

            //If the user specified default flags emit a changed event immediately
            if (cacheFlags) {
                AsyncStorage.getItem(FLAGSMITH_KEY, (err, res) => {
                    if (res) {
                        try {
                            var json = JSON.parse(res);
                            if (json && json.api === this.api && json.environmentID === this.environmentID) {
                                this.setState(json);
                                this.log("Retrieved flags from cache", json);
                            }

                            if (this.flags) { // retrieved flags from local storage
                                if (this.onChange) {
                                    this.onChange(null, { isFromServer: false });
                                }
                                this.oldFlags = this.flags;
                                resolve();
                                if (!preventFetch) {
                                    this.getFlags(Promise.resolve, Promise.reject);
                                }
                            } else {
                                if (!preventFetch) {
                                    this.getFlags(resolve, reject);
                                }
                            }
                        } catch (e) {
                            this.log("Exception fetching cached logs", e);
                        }
                    } else {
                        if (!preventFetch) {
                            this.getFlags(resolve, reject)
                        }
                    }
                });
            } else if (!preventFetch) {
                this.getFlags(resolve, reject);
            }
        })
    }

    getAllFlags() {
        return this.flags;
    }

    identify(userId) {
        this.identity = userId;
        if (this.initialised && !this.interval.length) {
            return this.getFlags();
        }
        return Promise.resolve();
    }

    getState() {
        return {
            api: this.api,
            environmentID: this.environmentID,
            flags: this.flags,
            identity: this.identity,
            segments: this.segments,
            traits: this.traits,
        }
    }

    setState(state) {
        if (state) {
            this.initialised = true;
            this.api = state.api || this.api || defaultAPI;
            this.environmentID = state.environmentID || this.environmentID;
            this.flags = state.flags || this.flags;
            this.identity = state.identity || this.identity;
            this.segments = state.segments || this.segments;
            this.traits = state.traits || this.traits;
            this.evaluationEvent = state.evaluationEvent || this.evaluationEvent;
        }
    }

    log(...args) {
        if (this.enableLogs) {
            console.log.apply(this, ["FLAGSMITH:", new Date().valueOf() - this.timer, "ms", ...args]);
        }
    }

    updateStorage() {
        if (this.cacheFlags) {
            const state = JSON.stringify(this.getState());
            this.log("Setting storage", state);
            AsyncStorage.setItem(FLAGSMITH_KEY, state);
        }
    }

    updateEventStorage() {
        if (this.sendFlagEvaluationEvents) {
            const state = JSON.stringify(this.getState());
            this.log("Setting event storage", state.evaluationEvent);
            AsyncStorage.setItem(FLAGSMITH_EVENT, state.evaluationEvent);
        }
    }

    logout() {
        this.identity = null;
        this.segments = null;
        this.traits = null;
        if (this.initialised && !this.interval.length) {
            this.getFlags();
        }
    }

    startListening(ticks = 1000) {
        if (this.interval.length) {
            return;
        }
        this.interval.push(setInterval(this.getFlags, ticks))
        if (this.sendFlagEvaluationEvents) {
            this.interval.push(setInterval(this.analyticsFlags, ticks))
        }
    }

    getSegments() {
        // noop for now
        // return this.segments;
    }

    stopListening() {
        this.interval.forEach(interval => {
            clearInterval(interval);
        });
    }


    evaluateFlag = (flag) => {
        if (sendFlagEvaluationEvents && flag) {
            if (!this.evaluationEvent.hasOwnProperty(flag.id)) {
                this.evaluationEvent[flag.id] = 0;
            }
            this.evaluationEvent[flag.id] += 1;
        }
        updateEventStorage();
    }


    getValue = (key) => {
        const flag = this.flags && this.flags[key];
        let res = null;
        if (flag) {
            res = flag.value;
        }
        evaluateFlag(this.flags[key]);

        //todo record check for value

        return res;
    }

    getTrait = (key) => {
        const trait = this.traits && this.traits[key];
        return trait;
    }

    setTrait = (key, trait_value) => {
        const { getJSON, identity, api } = this;

        if (!api) {
            console.error(initError("setTrait"))
            return
        }

        const body = {
            "identity": {
                "identifier": identity
            },
            "trait_key": key,
            "trait_value": trait_value
        }

        return getJSON(`${api}traits/`, 'POST', JSON.stringify(body))
            .then(() => {
                if (this.initialised) {
                    this.getFlags()
                }
            })
    };

    setTraits = (traits) => {
        const { getJSON, identity, api } = this;

        if (!api) {
            console.error(initError("setTraits"))
            return
        }

        if (!traits || typeof traits !== 'object') {
            console.error("Expected object for flagsmith.setTraits");
        }

        const body = Object.keys(traits).map((key) => (
            {
                "identity": {
                    "identifier": identity
                },
                "trait_key": key,
                "trait_value": traits[key]
            }
        ))

        return getJSON(`${api}traits/bulk/`, 'PUT', JSON.stringify(body))
            .then(() => {
                if (this.initialised) {
                    this.getFlags()
                }
            })
    };

    incrementTrait = (trait_key, increment_by) => {
        const { getJSON, identity, api } = this;
        return getJSON(`${api}traits/increment-value/`, 'POST', JSON.stringify({
            trait_key,
            increment_by,
            identifier: identity
        }))
            .then(this.getFlags)
    };

    hasFeature = (key) => {
        const flag = this.flags && this.flags[key];
        let res = false;
        if (flag && flag.enabled) {
            res = true;
        }
        evaluateFlag(this.flags[key]);

        //todo record check for feature

        return res;
    }

};

module.exports = function ({ fetch, AsyncStorage }) {
    return new Flagsmith({ fetch, AsyncStorage });
};

