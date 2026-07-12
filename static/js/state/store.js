// @ts-check

export const initialState = Object.freeze({
  snapshot: null,
  measurements: [],
  statistics: {
    status: "empty",
    total_count: 0,
    included_count: 0,
    excluded_count: 0,
    diameter: {},
    wall: {},
  },
  task: null,
  boxes: [],
  classNames: {},
  selectedMeasurementId: null,
  ui: {
    page: 1,
    pageSize: 100,
    sortDescending: true,
    roi: null,
    modelDirty: false,
    imageLoading: false,
  },
});

export function reducer(state, action) {
  switch (action.type) {
    case "SESSION_RECEIVED":
      return {
        ...state,
        snapshot: action.payload,
        task: action.payload.active_task || null,
      };
    case "MEASUREMENTS_RECEIVED":
      return {
        ...state,
        measurements: action.payload,
        ui: {
          ...state.ui,
          page: Math.min(
            state.ui.page,
            Math.max(1, Math.ceil(action.payload.length / state.ui.pageSize)),
          ),
        },
      };
    case "STATISTICS_RECEIVED":
      return { ...state, statistics: action.payload };
    case "TASK_RECEIVED":
      return { ...state, task: action.payload };
    case "TASK_CLEARED":
      return { ...state, task: null };
    case "RUN_RECEIVED":
      return {
        ...state,
        boxes: action.payload.boxes || [],
        classNames: action.payload.class_names || {},
      };
    case "SELECT_MEASUREMENT":
      return { ...state, selectedMeasurementId: action.payload };
    case "UI_PATCH":
      return { ...state, ui: { ...state.ui, ...action.payload } };
    case "RESET_IMAGE_STATE":
      return {
        ...state,
        measurements: [],
        boxes: [],
        task: null,
        selectedMeasurementId: null,
        statistics: initialState.statistics,
      };
    default:
      return state;
  }
}

export function createStore(initial, reduce = reducer) {
  let state = initial;
  const subscribers = new Set();
  return {
    getState: () => state,
    dispatch(action) {
      state = reduce(state, action);
      subscribers.forEach((subscriber) => subscriber(state, action));
      return action;
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}
