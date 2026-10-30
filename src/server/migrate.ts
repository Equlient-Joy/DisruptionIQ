import {configuredRepository} from './repository';
const repo=configuredRepository();try{await repo.init(false);console.log('PostgreSQL migrations applied.');}finally{await repo.close();}
