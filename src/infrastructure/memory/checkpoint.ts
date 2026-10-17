/** Something that can remember its state and go back to it. */
export interface Checkpointable {
  /** Returns a function that puts the state back as it is now. */
  checkpoint(): () => void;
}
