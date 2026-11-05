/** Native Pi shipped registration path with official SDK offline MSP fixture. */
import {registerMuseExtension} from "../index.js";
import {createMuseProvider} from "../src/provider.js";
import {openFixtureHost} from "./fixture-host.js";
export default async function(pi:any){
 const provider=createMuseProvider({openHost:openFixtureHost,promptModes:["replace"],promptMode:"replace",instructionMechanisms:["offline-fixture"],rawCompletion:true});
 await registerMuseExtension(pi,provider);
}
