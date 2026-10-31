import {configuredRepository} from './repository';
const repo=configuredRepository();try{await repo.init();console.log('Workspace and sign-in accounts initialized; existing records preserved.');}finally{await repo.close();}
